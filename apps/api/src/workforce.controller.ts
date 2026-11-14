import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, Post, Query, Req, UseGuards, Patch } from "@nestjs/common";
import { AttendanceStatus, AttendanceType, EmployeeRole } from "@prisma/client";
import { IsBoolean, IsEmail, IsIn, IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Length, Max, Min } from "class-validator";
import { createHash, randomBytes } from "node:crypto";
import { AuthGuard } from "./auth.guard";
import { PrismaService } from "./prisma.service";

type Request = { user: { id: string } };
class CheckInDto {
  @IsUUID() organizationId!: string;
  @IsOptional() @IsNumber() @Min(-90) @Max(90) latitude?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) longitude?: number;
  @IsOptional() @IsNumber() @Min(1) accuracyMeters?: number;
  @IsOptional() @IsIn(["OFFICE", "REMOTE"]) attendanceType?: AttendanceType;
}
class CheckOutDto {
  @IsUUID() organizationId!: string;
  @IsOptional() @IsNumber() @Min(-90) @Max(90) latitude?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) longitude?: number;
  @IsOptional() @IsNumber() @Min(1) accuracyMeters?: number;
}
class InviteDto { @IsEmail() email!: string; @IsString() @Length(1, 40) employeeNumber!: string; @IsOptional() @IsUUID() departmentId?: string; @IsString() @Length(2, 120) designation!: string; }
class RedeemInviteDto { @IsString() @Length(32, 200) inviteCode!: string; @IsString() @Length(2, 160) fullName!: string; @IsOptional() @IsString() @Length(1, 32) phone?: string; }
class DepartmentDto { @IsString() @Length(2, 120) name!: string; @IsOptional() @IsString() @Length(0, 500) description?: string; }
class LocationDto { @IsString() @Length(2, 120) name!: string; @IsNumber() @Min(-90) @Max(90) latitude!: number; @IsNumber() @Min(-180) @Max(180) longitude!: number; @IsNumber() @Min(20) @Max(10000) radiusMeters!: number; }
class WfhDto { @IsBoolean() enabled!: boolean; }
class CorrectionDto { @IsString() @Length(5, 1000) reason!: string; @IsOptional() @IsISO8601() checkInAt?: string; @IsOptional() @IsISO8601() checkOutAt?: string | null; }
const distanceMeters = (a: number, b: number, c: number, d: number) => {
  const rad = (n: number) => n * Math.PI / 180;
  const x = rad(c - a), y = rad(d - b);
  const h = Math.sin(x / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(y / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};

@Controller("workforce")
@UseGuards(AuthGuard)
export class WorkforceController {
  constructor(private readonly db: PrismaService) {}

  private async member(userId: string, organizationId: string, admin = false) {
    const employee = await this.db.employee.findFirst({ where: { supabaseUserId: userId, organizationId, status: "ACTIVE" }, include: { organization: true } });
    if (!employee || (admin && employee.role !== EmployeeRole.ADMINISTRATOR)) throw new NotFoundException("Active organization membership not found");
    return employee;
  }

  @Get("me") async me(@Req() req: Request) {
    const employees = await this.db.employee.findMany({ where: { supabaseUserId: req.user.id, status: "ACTIVE" }, include: { organization: { select: { id: true, name: true, timezone: true } }, department: true }, orderBy: { createdAt: "asc" } });
    return employees;
  }

  @Post("invites/:organizationId") async createInvite(@Req() req: Request, @Param("organizationId") organizationId: string, @Body() dto: InviteDto) {
    const admin = await this.member(req.user.id, organizationId, true);
    const rawCode = randomBytes(32).toString("base64url");
    const codeHash = createHash("sha256").update(rawCode).digest("hex");
    const email = dto.email.trim().toLowerCase();
    const duplicate = await this.db.organizationInvite.findFirst({ where: { organizationId, email, redeemedAt: null } });
    if (duplicate) throw new ConflictException("An active invitation already exists for this email");
    const invite = await this.db.organizationInvite.create({ data: { organizationId, email, employeeNumber: dto.employeeNumber, departmentId: dto.departmentId, designation: dto.designation, codeHash, createdByEmployeeId: admin.id, expiresAt: new Date(Date.now() + 7 * 86400000) } });
    return { id: invite.id, email, expiresAt: invite.expiresAt, inviteCode: rawCode };
  }

  @Post("invites/:organizationId/redeem") async redeemInvite(@Req() req: Request, @Param("organizationId") organizationId: string, @Body() dto: RedeemInviteDto) {
    const invite = await this.db.organizationInvite.findFirst({ where: { organizationId, codeHash: createHash("sha256").update(dto.inviteCode).digest("hex"), redeemedAt: null, expiresAt: { gt: new Date() } } });
    if (!invite) throw new BadRequestException("Invitation is invalid or expired");
    if (await this.db.employee.findFirst({ where: { supabaseUserId: req.user.id, organizationId } })) throw new ConflictException("This account is already linked to the organization");
    const authUser = await this.db.$queryRaw<Array<{ email: string | null }>>`SELECT email FROM auth.users WHERE id = ${req.user.id}::uuid`;
    if (authUser[0]?.email?.toLowerCase() !== invite.email.toLowerCase()) throw new BadRequestException("Sign in with the invited email address");
    return this.db.$transaction(async tx => {
      const consumed = await tx.organizationInvite.updateMany({ where: { id: invite.id, redeemedAt: null, expiresAt: { gt: new Date() } }, data: { redeemedAt: new Date() } });
      if (consumed.count !== 1) throw new ConflictException("Invitation has already been used");
      const employee = await tx.employee.create({ data: { organizationId, supabaseUserId: req.user.id, employeeNumber: invite.employeeNumber, fullName: dto.fullName, email: invite.email, phone: dto.phone, departmentId: invite.departmentId, designation: invite.designation, status: "ACTIVE" } });
      await tx.attendanceEvent.create({ data: { organizationId, employeeId: employee.id, type: "EMPLOYEE_CREATED", metadata: { source: "invite" } } });
      return employee;
    });
  }

  @Post(":organizationId/departments") async createDepartment(@Req() req: Request, @Param("organizationId") organizationId: string, @Body() dto: DepartmentDto) {
    await this.member(req.user.id, organizationId, true);
    return this.db.department.create({ data: { organizationId, name: dto.name.trim(), description: dto.description?.trim() } });
  }

  @Post(":organizationId/locations") async createLocation(@Req() req: Request, @Param("organizationId") organizationId: string, @Body() dto: LocationDto) {
    await this.member(req.user.id, organizationId, true);
    return this.db.officeLocation.create({ data: { organizationId, name: dto.name.trim(), latitude: dto.latitude, longitude: dto.longitude, radiusMeters: dto.radiusMeters } });
  }

  @Get(":organizationId/employees") async employees(@Req() req: Request, @Param("organizationId") organizationId: string) {
    await this.member(req.user.id, organizationId, true);
    return this.db.employee.findMany({ where: { organizationId }, select: { id: true, employeeNumber: true, fullName: true, email: true, phone: true, designation: true, role: true, status: true, department: { select: { id: true, name: true } } }, orderBy: { fullName: "asc" }, take: 500 });
  }

  @Patch(":organizationId/employees/:employeeId/wfh") async setWfh(@Req() req: Request, @Param("organizationId") organizationId: string, @Param("employeeId") employeeId: string, @Body() dto: WfhDto) {
    const admin = await this.member(req.user.id, organizationId, true);
    const employee = await this.db.employee.findFirst({ where: { id: employeeId, organizationId } });
    if (!employee) throw new NotFoundException("Employee not found");
    return this.db.$transaction(async tx => {
      const updated = await tx.employee.update({ where: { id: employeeId }, data: { wfhEnabled: dto.enabled } });
      await tx.auditLog.create({ data: { organizationId, actorEmployeeId: admin.id, action: "EMPLOYEE_WFH_PERMISSION_UPDATED", entityType: "Employee", entityId: employeeId, previousValues: { wfhEnabled: employee.wfhEnabled }, newValues: { wfhEnabled: dto.enabled } } });
      return updated;
    });
  }

  @Get(":organizationId/dashboard") async dashboard(@Req() req: Request, @Param("organizationId") organizationId: string, @Query("date") date?: string) {
    const employee = await this.member(req.user.id, organizationId, true);
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequestException("Invalid date");
    const nowParts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: employee.organization.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).map(x => [x.type, x.value]));
    const key = new Date(`${date ?? `${nowParts.year}-${nowParts.month}-${nowParts.day}`}T00:00:00.000Z`);
    if (Number.isNaN(key.getTime())) throw new BadRequestException("Invalid date");
    const [employees, records] = await Promise.all([
      this.db.employee.count({ where: { organizationId, status: "ACTIVE" } }),
      this.db.attendanceRecord.findMany({ where: { organizationId, workDate: key }, include: { employee: { select: { id: true, fullName: true, employeeNumber: true, department: { select: { name: true } } } } } }),
    ]);
    const present = records.filter(r => r.status !== AttendanceStatus.ABSENT && r.status !== AttendanceStatus.LEAVE).length;
    return { date: key.toISOString().slice(0, 10), totals: { employees, present, absent: Math.max(0, employees - records.length), wfh: records.filter(r => r.attendanceType === AttendanceType.REMOTE).length, late: records.filter(r => r.status === AttendanceStatus.LATE).length }, records };
  }

  @Get(":organizationId/attendance") async attendance(@Req() req: Request, @Param("organizationId") organizationId: string, @Query("from") from?: string, @Query("to") to?: string, @Query("employeeId") employeeId?: string) {
    const member = await this.member(req.user.id, organizationId);
    const start = from ? new Date(`${from}T00:00:00.000Z`) : new Date(Date.now() - 30 * 86400000);
    const end = to ? new Date(`${to}T00:00:00.000Z`) : new Date();
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) throw new BadRequestException("Invalid date range");
    return this.db.attendanceRecord.findMany({ where: { organizationId, employeeId: member.role === EmployeeRole.ADMINISTRATOR ? employeeId : member.id, workDate: { gte: start, lte: end } }, orderBy: { workDate: "desc" }, take: 500 });
  }

  @Post("attendance/check-in") async checkIn(@Req() req: Request, @Body() dto: CheckInDto) {
    const employee = await this.member(req.user.id, dto.organizationId);
    const settings = employee.organization.settings as { shiftStart?: string; lateGraceMinutes?: number; maxGpsAccuracyMeters?: number };
    const type = dto.attendanceType ?? AttendanceType.OFFICE;
    if (type === AttendanceType.REMOTE && !employee.wfhEnabled) throw new BadRequestException("Work from home is not enabled for this employee");
    if (type === AttendanceType.OFFICE && (dto.latitude === undefined || dto.longitude === undefined || dto.accuracyMeters === undefined)) throw new BadRequestException("GPS coordinates and accuracy are required for office check-in");
    if (type === AttendanceType.OFFICE && dto.accuracyMeters! > (settings.maxGpsAccuracyMeters ?? 100)) throw new BadRequestException("Location accuracy is too low; try again with a clearer GPS signal");
    const offices = type === AttendanceType.OFFICE ? await this.db.officeLocation.findMany({ where: { organizationId: dto.organizationId, active: true } }) : [];
    let chosen: typeof offices[number] | undefined, distance = 0;
    if (type === AttendanceType.OFFICE) {
      const matches = offices.map(location => ({ location, distance: distanceMeters(Number(location.latitude), Number(location.longitude), dto.latitude!, dto.longitude!) })).filter(x => x.distance <= x.location.radiusMeters).sort((a,b) => a.distance - b.distance);
      if (!matches.length) throw new BadRequestException("You are outside the configured office radius");
      chosen = matches[0].location; distance = matches[0].distance;
    }
    const now = new Date();
    const dateParts = new Intl.DateTimeFormat("en-CA", { timeZone: employee.organization.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
    const p = Object.fromEntries(dateParts.map(x => [x.type, x.value]));
    const workDate = new Date(`${p.year}-${p.month}-${p.day}T00:00:00.000Z`);
    const grace = settings.lateGraceMinutes ?? 5;
    const shift = settings.shiftStart ?? "09:00";
    const [shiftHour, shiftMinute] = shift.split(":").map(Number);
    const currentMinutes = Number(p.hour) * 60 + Number(p.minute);
    const lateMinutes = Math.max(0, currentMinutes - (shiftHour * 60 + shiftMinute) - grace);
    try {
      return await this.db.$transaction(async tx => {
        const record = await tx.attendanceRecord.create({ data: { organizationId: dto.organizationId, employeeId: employee.id, workDate, checkInAt: now, status: lateMinutes > 0 ? AttendanceStatus.LATE : AttendanceStatus.IN_PROGRESS, lateMinutes, attendanceType: type, checkInLocationId: chosen?.id }, });
        await tx.attendanceEvent.create({ data: { organizationId: dto.organizationId, attendanceId: record.id, employeeId: employee.id, locationId: chosen?.id, type: "CHECK_IN", occurredAt: now, latitude: dto.latitude, longitude: dto.longitude, accuracyMeters: dto.accuracyMeters, distanceMeters: chosen ? distance : undefined } });
        await tx.auditLog.create({ data: { organizationId: dto.organizationId, actorEmployeeId: employee.id, action: "ATTENDANCE_CHECK_IN", entityType: "AttendanceRecord", entityId: record.id, newValues: { workDate: workDate.toISOString().slice(0, 10), attendanceType: type, checkInAt: now.toISOString() } } });
        return record;
      });
    } catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "P2002") throw new ConflictException("You have already checked in today"); throw error; }
  }

  @Post("attendance/check-out") async checkOut(@Req() req: Request, @Body() dto: CheckOutDto) {
    const employee = await this.member(req.user.id, dto.organizationId);
    const record = await this.db.attendanceRecord.findFirst({ where: { organizationId: dto.organizationId, employeeId: employee.id, checkInAt: { not: null }, checkOutAt: null }, orderBy: { workDate: "desc" } });
    if (!record?.checkInAt) throw new ConflictException("There is no open attendance record");
    let locationId: string | undefined, distance: number | undefined;
    if (record.attendanceType === AttendanceType.OFFICE) {
      if (dto.latitude === undefined || dto.longitude === undefined || dto.accuracyMeters === undefined) throw new BadRequestException("GPS coordinates and accuracy are required for office check-out");
      const settings = employee.organization.settings as { maxGpsAccuracyMeters?: number };
      if (dto.accuracyMeters > (settings.maxGpsAccuracyMeters ?? 100)) throw new BadRequestException("Location accuracy is too low; try again with a clearer GPS signal");
      const offices = await this.db.officeLocation.findMany({ where: { organizationId: dto.organizationId, active: true } });
      const match = offices.map(location => ({ location, distance: distanceMeters(Number(location.latitude), Number(location.longitude), dto.latitude!, dto.longitude!) })).filter(x => x.distance <= x.location.radiusMeters).sort((a,b) => a.distance - b.distance)[0];
      if (!match) throw new BadRequestException("You are outside the configured office radius");
      locationId = match.location.id; distance = match.distance;
    }
    const now = new Date(), minutes = Math.max(0, Math.floor((now.getTime() - record.checkInAt.getTime()) / 60000));
    return this.db.$transaction(async tx => {
      const transition = await tx.attendanceRecord.updateMany({ where: { id: record.id, organizationId: dto.organizationId, checkOutAt: null }, data: { checkOutAt: now, totalWorkMinutes: minutes, status: record.lateMinutes > 0 ? AttendanceStatus.LATE : AttendanceStatus.PRESENT } });
      if (transition.count !== 1) throw new ConflictException("This attendance record was already checked out");
      const updated = await tx.attendanceRecord.findUniqueOrThrow({ where: { id: record.id } });
      await tx.attendanceEvent.create({ data: { organizationId: dto.organizationId, attendanceId: record.id, employeeId: employee.id, locationId, type: "CHECK_OUT", occurredAt: now, latitude: dto.latitude, longitude: dto.longitude, accuracyMeters: dto.accuracyMeters, distanceMeters: distance } });
      await tx.auditLog.create({ data: { organizationId: dto.organizationId, actorEmployeeId: employee.id, action: "ATTENDANCE_CHECK_OUT", entityType: "AttendanceRecord", entityId: record.id, previousValues: { checkOutAt: null }, newValues: { checkOutAt: now.toISOString(), totalWorkMinutes: minutes } } });
      return updated;
    });
  }

  @Get(":organizationId/departments") async departments(@Req() req: Request, @Param("organizationId") organizationId: string) { await this.member(req.user.id, organizationId); return this.db.department.findMany({ where: { organizationId }, orderBy: { name: "asc" } }); }
  @Get(":organizationId/locations") async locations(@Req() req: Request, @Param("organizationId") organizationId: string) { await this.member(req.user.id, organizationId); return this.db.officeLocation.findMany({ where: { organizationId, active: true }, select: { id: true, name: true, radiusMeters: true } }); }
  @Post(":organizationId/attendance/:attendanceId/correction") async correction(@Req() req: Request, @Param("organizationId") organizationId: string, @Param("attendanceId") attendanceId: string, @Body() body: CorrectionDto) {
    const admin = await this.member(req.user.id, organizationId, true);
    if (!body.reason || body.reason.trim().length < 5 || body.reason.length > 1000) throw new BadRequestException("A correction reason of 5 to 1000 characters is required");
    const record = await this.db.attendanceRecord.findFirst({ where: { id: attendanceId, organizationId } }); if (!record) throw new NotFoundException();
    const checkInAt = body.checkInAt ? new Date(body.checkInAt) : record.checkInAt;
    const checkOutAt = body.checkOutAt !== undefined ? (body.checkOutAt ? new Date(body.checkOutAt) : null) : record.checkOutAt;
    if (checkInAt && checkOutAt && checkOutAt <= checkInAt) throw new BadRequestException("Check-out must be after check-in");
    const updated = await this.db.$transaction(async tx => {
      const next = await tx.attendanceRecord.update({ where: { id: attendanceId }, data: { ...(body.checkInAt ? { checkInAt } : {}), ...(body.checkOutAt !== undefined ? { checkOutAt, totalWorkMinutes: checkInAt && checkOutAt ? Math.floor((checkOutAt.getTime() - checkInAt.getTime()) / 60000) : null, status: checkOutAt ? (record.lateMinutes > 0 ? AttendanceStatus.LATE : AttendanceStatus.PRESENT) : (record.lateMinutes > 0 ? AttendanceStatus.LATE : AttendanceStatus.IN_PROGRESS) } : {}) } });
      await tx.attendanceEvent.create({ data: { organizationId, attendanceId, employeeId: record.employeeId, actorEmployeeId: admin.id, type: "CORRECTION", metadata: { reason: body.reason } } });
      await tx.auditLog.create({ data: { organizationId, actorEmployeeId: admin.id, action: "ATTENDANCE_CORRECTION", entityType: "AttendanceRecord", entityId: attendanceId, reason: body.reason, previousValues: { checkInAt: record.checkInAt?.toISOString() ?? null, checkOutAt: record.checkOutAt?.toISOString() ?? null }, newValues: { checkInAt: next.checkInAt?.toISOString() ?? null, checkOutAt: next.checkOutAt?.toISOString() ?? null } } });
      return next;
    });
    return updated;
  }
}
