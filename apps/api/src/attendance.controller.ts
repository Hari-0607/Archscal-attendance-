import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { createHmac } from "node:crypto";
import { IsArray, IsBoolean, IsDateString, IsIn, IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Length, Max, Min } from "class-validator";
import { AuthGuard } from "./auth.guard";
import { SupabaseService } from "./supabase.service";

class OrganizationDto { @IsString() @Length(2, 120) name!: string; @IsString() @Length(3, 64) timezone!: string; }
class AttendanceDto {
  @IsUUID() organizationId!: string;
  @IsOptional() @IsUUID() locationId?: string;
  @IsOptional() @IsNumber() @Min(-90) @Max(90) latitude?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) longitude?: number;
  @IsOptional() @IsString() @Length(32, 200) qrToken?: string;
  @IsOptional() @IsIn(["office","hybrid","remote","field"]) attendanceType?: string;
}
class LeaveDto {
  @IsUUID() organizationId!: string;
  @IsString() @Length(2, 40) leaveType!: string;
  @IsISO8601({ strict: true }) startDate!: string;
  @IsISO8601({ strict: true }) endDate!: string;
  @IsOptional() @IsString() @Length(0, 2000) reason?: string;
}
class DecisionDto { @IsIn(["approved", "rejected"]) decision!: "approved" | "rejected"; @IsOptional() @IsString() @Length(0, 1000) reason?: string; }
class CorrectionDto { @IsISO8601() checkInAt!: string; @IsOptional() @IsISO8601() checkOutAt?: string | null; @IsString() @Length(5, 1000) reason!: string; }
class ShiftDto { @IsString() @Length(2, 80) name!: string; @IsString() @Length(5, 8) startTime!: string; @IsString() @Length(5, 8) endTime!: string; @IsOptional() @IsNumber() @Min(0) @Max(240) graceMinutes?: number; @IsOptional() @IsNumber() @Min(0) @Max(480) breakMinutes?: number; }
class ShiftAssignmentDto { @IsUUID() userId!: string; @IsUUID() shiftId!: string; @IsDateString() workDate!: string; }
class LocationDto { @IsString() @Length(2, 100) name!: string; @IsNumber() @Min(-90) @Max(90) latitude!: number; @IsNumber() @Min(-180) @Max(180) longitude!: number; @IsOptional() @IsNumber() @Min(20) @Max(5000) radiusMeters?: number; @IsOptional() @IsBoolean() geofenceRequired?: boolean; }
class WorkforceEventDto { @IsOptional() @IsUUID() organizationId?: string; @IsIn(["login","logout","session_refresh","module_view"]) eventType!: string; @IsOptional() @IsString() @Length(0, 100) module?: string; }
class MemberRoleDto { @IsIn(["admin","hr","manager","employee","auditor"]) role!: string; }
class AttendancePolicyDto { @IsArray() @IsString({ each: true }) @IsIn(["office","hybrid","remote","field"], { each: true }) allowedTypes!: string[]; }
type AuthedRequest = { headers: { authorization?: string }; user: { id: string; email: string | null } };
const dateInZone = (date: Date, timezone: string) => { const values = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date); const parts = Object.fromEntries(values.map((p) => [p.type,p.value])); return `${parts.year}-${parts.month}-${parts.day}`; };

@Controller()
@UseGuards(AuthGuard)
export class AttendanceController {
  constructor(private readonly supabase: SupabaseService) {}
  private client(req: AuthedRequest) { return this.supabase.client(req.headers.authorization!.slice(7)); }

  @Get("me") async me(@Req() req: AuthedRequest) { return { id: req.user.id, email: req.user.email }; }

  @Post("session-events") async logSessionEvent(@Req() req: AuthedRequest, @Body() body: WorkforceEventDto) {
    const hashSecret = process.env.IP_HASH_SECRET;
    const ip = (req as AuthedRequest & { ip?: string }).ip;
    const ipHash = hashSecret && ip ? createHmac("sha256", hashSecret).update(ip).digest("hex") : null;
    const userAgent = (req as AuthedRequest & { headers: { authorization?: string; "user-agent"?: string } }).headers["user-agent"] ?? null;
    const metadata = body.eventType === "module_view" && body.module ? { module: body.module } : {};
    const { data, error } = await this.client(req).rpc("log_workforce_event", { p_organization_id: body.organizationId ?? null, p_event_type: body.eventType, p_ip_hash: ipHash, p_user_agent: userAgent, p_metadata: metadata });
    if (error) throw new BadRequestException(error.message);
    return { id: data };
  }

  @Post("organizations") async createOrganization(@Req() req: AuthedRequest, @Body() body: OrganizationDto) {
    const { data, error } = await this.client(req).rpc("create_organization", { p_name: body.name, p_timezone: body.timezone });
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  @Get("organizations") async organizations(@Req() req: AuthedRequest) {
    const { data, error } = await this.client(req).from("organization_members").select("role,active,organizations(id,name,timezone,settings)").eq("user_id", req.user.id).eq("active", true);
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  @Get("organizations/:organizationId/overview") async overview(@Req() req: AuthedRequest, @Param("organizationId") organizationId: string) {
    const client = this.client(req);
    const org = await client.from("organizations").select("timezone").eq("id", organizationId).single();
    if (org.error) throw new BadRequestException(org.error.message);
    const dateKey = dateInZone(new Date(), org.data.timezone);
    const [attendance, members, shifts, leave, currentBreak] = await Promise.all([
      client.from("attendance_records").select("id,user_id,attendance_date,check_in_at,check_out_at,status,attendance_type,profiles(full_name,email)").eq("organization_id", organizationId).eq("attendance_date", dateKey).order("check_in_at", { ascending: false }).limit(500),
      client.from("organization_members").select("user_id,role,active,profiles(full_name,email)").eq("organization_id", organizationId).eq("active", true).limit(500),
      client.from("employee_shifts").select("id,user_id,shift_id,work_date,shifts(name,start_time,end_time),profiles(full_name,email)").eq("organization_id", organizationId).gte("work_date", dateKey).limit(100),
      client.from("leave_requests").select("id,user_id,leave_type,start_date,end_date,status").eq("organization_id", organizationId).eq("status", "pending").limit(100),
      client.from("attendance_breaks").select("id,started_at").eq("organization_id", organizationId).eq("user_id", req.user.id).is("ended_at", null).order("started_at", { ascending: false }).limit(1),
    ]);
    for (const result of [attendance, members, shifts, leave, currentBreak]) if (result.error) throw new BadRequestException(result.error.message);
    const rows = attendance.data ?? [];
    return { attendance: rows, members: members.data ?? [], shifts: shifts.data ?? [], pendingLeave: leave.data ?? [], activeBreak: currentBreak.data?.[0] ?? null, metrics: { present: rows.filter((r) => ["present", "late", "in_progress"].includes(r.status)).length, late: rows.filter((r) => r.status === "late").length, pendingLeave: leave.data?.length ?? 0, activeMembers: members.data?.length ?? 0 } };
  }

  @Post("attendance/check-in") async checkIn(@Req() req: AuthedRequest, @Body() body: AttendanceDto) {
    const { data, error } = await this.client(req).rpc("attendance_check_in", { p_organization_id: body.organizationId, p_location_id: body.locationId ?? null, p_latitude: body.latitude ?? null, p_longitude: body.longitude ?? null, p_qr_token: body.qrToken ?? null, p_attendance_type: body.attendanceType ?? "office" });
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  @Post("attendance/check-out") async checkOut(@Req() req: AuthedRequest, @Body() body: AttendanceDto) {
    const { data, error } = await this.client(req).rpc("attendance_check_out", { p_organization_id: body.organizationId, p_latitude: body.latitude ?? null, p_longitude: body.longitude ?? null });
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  @Post("attendance/break/start") async breakStart(@Req() req: AuthedRequest, @Body() body: AttendanceDto) { return this.breakAction(req, body.organizationId, "start"); }
  @Post("attendance/break/end") async breakEnd(@Req() req: AuthedRequest, @Body() body: AttendanceDto) { return this.breakAction(req, body.organizationId, "end"); }
  private async breakAction(req: AuthedRequest, organizationId: string, action: "start" | "end") {
    const { data, error } = await this.client(req).rpc("attendance_break", { p_organization_id: organizationId, p_action: action });
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  @Get("organizations/:organizationId/attendance/history") async history(@Req() req: AuthedRequest, @Param("organizationId") organizationId: string) {
    const { data, error } = await this.client(req).from("attendance_records").select("*").eq("organization_id", organizationId).order("attendance_date", { ascending: false }).limit(100);
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  @Post("leave") async requestLeave(@Req() req: AuthedRequest, @Body() body: LeaveDto) {
    if (body.endDate < body.startDate) throw new BadRequestException("End date must be on or after the start date");
    const { data, error } = await this.client(req).from("leave_requests").insert({ organization_id: body.organizationId, user_id: req.user.id, leave_type: body.leaveType, start_date: body.startDate, end_date: body.endDate, reason: body.reason ?? "" }).select().single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  @Get("organizations/:organizationId/leave") async leaveRequests(@Req() req: AuthedRequest, @Param("organizationId") organizationId: string) {
    const { data, error } = await this.client(req).from("leave_requests").select("id,user_id,leave_type,start_date,end_date,reason,status,manager_reason,hr_reason,created_at,profiles(full_name,email)").eq("organization_id", organizationId).order("created_at", { ascending: false }).limit(200);
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  @Post("organizations/:organizationId/leave/:leaveId/decision") async decideLeave(@Req() req: AuthedRequest, @Param("organizationId") organizationId: string, @Param("leaveId") leaveId: string, @Body() body: DecisionDto) {
    const { data, error } = await this.client(req).rpc("decide_leave_request", { p_organization_id: organizationId, p_leave_id: leaveId, p_decision: body.decision, p_reason: body.reason ?? "" });
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  @Get("organizations/:organizationId/audit") async audit(@Req() req: AuthedRequest, @Param("organizationId") organizationId: string) {
    const { data, error } = await this.client(req).from("audit_logs").select("*").eq("organization_id", organizationId).order("created_at", { ascending: false }).limit(200);
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  @Get("organizations/:organizationId/security/events") async workforceEvents(@Req() req: AuthedRequest, @Param("organizationId") organizationId: string) {
    const { data, error } = await this.client(req).from("workforce_events").select("id,user_id,event_type,occurred_at,ip_hash,device_id,user_agent,metadata").eq("organization_id", organizationId).order("occurred_at", { ascending: false }).limit(200);
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  @Get("organizations/:organizationId/locations") async locations(@Req() req: AuthedRequest, @Param("organizationId") organizationId: string) {
    const { data, error } = await this.client(req).from("office_locations").select("id,name,latitude,longitude,radius_meters,geofence_required").eq("organization_id", organizationId).eq("active", true);
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  @Get("organizations/:organizationId/members") async members(@Req() req: AuthedRequest, @Param("organizationId") organizationId: string) {
    const { data, error } = await this.client(req).from("organization_members").select("user_id,role,active,employee_code,profiles(full_name,email)").eq("organization_id", organizationId).order("joined_at", { ascending: true }).limit(1000);
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  @Patch("organizations/:organizationId/members/:userId/role") async changeMemberRole(@Req() req: AuthedRequest, @Param("organizationId") organizationId: string, @Param("userId") userId: string, @Body() body: MemberRoleDto) {
    const { data, error } = await this.client(req).rpc("change_member_role", { p_organization_id: organizationId, p_user_id: userId, p_role: body.role });
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  @Get("organizations/:organizationId/settings") async settings(@Req() req: AuthedRequest, @Param("organizationId") organizationId: string) {
    const { data, error } = await this.client(req).from("organizations").select("id,name,timezone,settings").eq("id", organizationId).single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  @Patch("organizations/:organizationId/attendance-policy") async attendancePolicy(@Req() req: AuthedRequest, @Param("organizationId") organizationId: string, @Body() body: AttendancePolicyDto) {
    if (!Array.isArray(body.allowedTypes) || body.allowedTypes.length < 1 || body.allowedTypes.length > 4) throw new BadRequestException("Select one or more attendance modes");
    const { data, error } = await this.client(req).rpc("set_attendance_policy", { p_organization_id: organizationId, p_allowed_types: body.allowedTypes });
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  @Post("organizations/:organizationId/locations") async createLocation(@Req() req: AuthedRequest, @Param("organizationId") organizationId: string, @Body() body: LocationDto) {
    const { data, error } = await this.client(req).from("office_locations").insert({ organization_id: organizationId, name: body.name, latitude: body.latitude, longitude: body.longitude, radius_meters: body.radiusMeters ?? 100, geofence_required: body.geofenceRequired ?? true }).select("id,name,latitude,longitude,radius_meters,geofence_required").single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  @Get("organizations/:organizationId/shifts") async shifts(@Req() req: AuthedRequest, @Param("organizationId") organizationId: string) {
    const { data, error } = await this.client(req).from("shifts").select("*").eq("organization_id", organizationId).eq("active", true).order("start_time");
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  @Post("organizations/:organizationId/shifts") async createShift(@Req() req: AuthedRequest, @Param("organizationId") organizationId: string, @Body() body: ShiftDto) {
    const { data, error } = await this.client(req).from("shifts").insert({ organization_id: organizationId, name: body.name, start_time: body.startTime, end_time: body.endTime, grace_minutes: body.graceMinutes ?? 5, break_minutes: body.breakMinutes ?? 30 }).select().single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  @Post("organizations/:organizationId/shifts/assign") async assignShift(@Req() req: AuthedRequest, @Param("organizationId") organizationId: string, @Body() body: ShiftAssignmentDto) {
    const { data, error } = await this.client(req).from("employee_shifts").upsert({ organization_id: organizationId, user_id: body.userId, shift_id: body.shiftId, work_date: body.workDate, assigned_by: req.user.id }, { onConflict: "organization_id,user_id,work_date" }).select().single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  @Post("organizations/:organizationId/qr-challenges") async createQrChallenge(@Req() req: AuthedRequest, @Param("organizationId") organizationId: string, @Body() body: { locationId?: string }) {
    const { data, error } = await this.client(req).rpc("create_qr_challenge", { p_organization_id: organizationId, p_location_id: body.locationId ?? null });
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  @Post("organizations/:organizationId/attendance/:attendanceId/correction") async correctAttendance(@Req() req: AuthedRequest, @Param("organizationId") organizationId: string, @Param("attendanceId") attendanceId: string, @Body() body: CorrectionDto) {
    const { data, error } = await this.client(req).rpc("correct_attendance", { p_organization_id: organizationId, p_attendance_id: attendanceId, p_check_in: body.checkInAt, p_check_out: body.checkOutAt ?? null, p_reason: body.reason });
    if (error) throw new BadRequestException(error.message);
    return data;
  }
}
