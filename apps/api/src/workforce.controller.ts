import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { IsBoolean, IsEmail, IsIn, IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Length, Max, Min } from "class-validator";
import type { Request } from "express";
import type { AuthenticatedUser } from "./auth/authenticated-user";
import { AuthGuard } from "./auth.guard";
import { WorkforceService } from "./workforce/workforce.service";

type AuthenticatedRequest = Request & { user: AuthenticatedUser };
class OrganizationDto { @IsString() @Length(2, 160) name!: string; @IsString() @Length(1, 64) timezone!: string; }
class InviteDto { @IsEmail() email!: string; @IsString() @Length(1, 40) employeeNumber!: string; @IsOptional() @IsUUID() departmentId?: string; @IsString() @Length(2, 120) designation!: string; }
class RedeemInviteDto { @IsString() @Length(32, 200) inviteCode!: string; @IsString() @Length(2, 160) fullName!: string; @IsOptional() @IsString() @Length(1, 32) phone?: string; }
class AttendanceDto { @IsUUID() organizationId!: string; @IsOptional() @IsNumber() @Min(-90) @Max(90) latitude?: number; @IsOptional() @IsNumber() @Min(-180) @Max(180) longitude?: number; @IsOptional() @IsNumber() @Min(1) @Max(100000) accuracyMeters?: number; @IsOptional() @IsIn(["OFFICE", "REMOTE"]) attendanceType?: "OFFICE" | "REMOTE"; }
class DepartmentDto { @IsString() @Length(2, 120) name!: string; @IsOptional() @IsString() @Length(0, 500) description?: string; }
class LocationDto { @IsString() @Length(2, 120) name!: string; @IsNumber() @Min(-90) @Max(90) latitude!: number; @IsNumber() @Min(-180) @Max(180) longitude!: number; @IsNumber() @Min(20) @Max(10000) radiusMeters!: number; }
class WfhDto { @IsBoolean() enabled!: boolean; }
class EmployeeDto { @IsOptional() @IsString() @Length(2, 160) fullName?: string; @IsOptional() @IsString() @Length(1, 32) phone?: string | null; @IsOptional() @IsString() @Length(2, 120) designation?: string; @IsOptional() @IsUUID() departmentId?: string | null; @IsOptional() @IsIn(["ACTIVE", "DEACTIVATED"]) status?: "ACTIVE" | "DEACTIVATED"; }
class LocationUpdateDto { @IsOptional() @IsString() @Length(2, 120) name?: string; @IsOptional() @IsNumber() @Min(-90) @Max(90) latitude?: number; @IsOptional() @IsNumber() @Min(-180) @Max(180) longitude?: number; @IsOptional() @IsNumber() @Min(20) @Max(10000) radiusMeters?: number; @IsOptional() @IsBoolean() active?: boolean; }
class CorrectionDto { @IsString() @Length(5, 1000) reason!: string; @IsOptional() @IsISO8601() checkInAt?: string; @IsOptional() @IsISO8601() checkOutAt?: string | null; }

@Controller("workforce")
@UseGuards(AuthGuard)
export class WorkforceController {
  constructor(private readonly workforce: WorkforceService) {}

  @Get("me") me(@Req() req: AuthenticatedRequest) { return this.workforce.me(req.user); }
  @Post("organizations") createOrganization(@Req() req: AuthenticatedRequest, @Body() dto: OrganizationDto) { return this.workforce.createOrganization(req.user, dto); }
  @Post("invites/:organizationId") createInvite(@Req() req: AuthenticatedRequest, @Param("organizationId", ParseUUIDPipe) id: string, @Body() dto: InviteDto) { return this.workforce.createInvite(req.user, id, dto); }
  @Post("invites/redeem") redeemInvite(@Req() req: AuthenticatedRequest, @Body() dto: RedeemInviteDto) { return this.workforce.redeemInvite(req.user, dto); }
  @Get(":organizationId/dashboard") dashboard(@Req() req: AuthenticatedRequest, @Param("organizationId", ParseUUIDPipe) id: string, @Query("date") date?: string) { return this.workforce.dashboard(req.user, id, date); }
  @Get(":organizationId/attendance") attendance(@Req() req: AuthenticatedRequest, @Param("organizationId", ParseUUIDPipe) id: string, @Query("from") from?: string, @Query("to") to?: string, @Query("employeeId", new ParseUUIDPipe({ optional: true })) employeeId?: string) { return this.workforce.attendance(req.user, id, { from, to, employeeId }); }
  @Post("attendance/check-in") checkIn(@Req() req: AuthenticatedRequest, @Body() dto: AttendanceDto, @Headers("idempotency-key") key?: string) { return this.workforce.checkIn(req.user, dto, key ?? "", req.ip); }
  @Post("attendance/check-out") checkOut(@Req() req: AuthenticatedRequest, @Body() dto: AttendanceDto, @Headers("idempotency-key") key?: string) { return this.workforce.checkOut(req.user, dto, key ?? "", req.ip); }
  @Get(":organizationId/departments") departments(@Req() req: AuthenticatedRequest, @Param("organizationId", ParseUUIDPipe) id: string) { return this.workforce.departments(req.user, id); }
  @Post(":organizationId/departments") createDepartment(@Req() req: AuthenticatedRequest, @Param("organizationId", ParseUUIDPipe) id: string, @Body() dto: DepartmentDto) { return this.workforce.createDepartment(req.user, id, dto); }
  @Get(":organizationId/employees") employees(@Req() req: AuthenticatedRequest, @Param("organizationId", ParseUUIDPipe) id: string) { return this.workforce.employees(req.user, id); }
  @Patch(":organizationId/employees/:employeeId") updateEmployee(@Req() req: AuthenticatedRequest, @Param("organizationId", ParseUUIDPipe) id: string, @Param("employeeId", ParseUUIDPipe) employeeId: string, @Body() dto: EmployeeDto) { return this.workforce.updateEmployee(req.user, id, employeeId, dto); }
  @Patch(":organizationId/employees/:employeeId/wfh") setWfh(@Req() req: AuthenticatedRequest, @Param("organizationId", ParseUUIDPipe) id: string, @Param("employeeId", ParseUUIDPipe) employeeId: string, @Body() dto: WfhDto) { return this.workforce.setWfh(req.user, id, employeeId, dto.enabled); }
  @Get(":organizationId/locations") locations(@Req() req: AuthenticatedRequest, @Param("organizationId", ParseUUIDPipe) id: string) { return this.workforce.locations(req.user, id); }
  @Post(":organizationId/locations") createLocation(@Req() req: AuthenticatedRequest, @Param("organizationId", ParseUUIDPipe) id: string, @Body() dto: LocationDto) { return this.workforce.createLocation(req.user, id, dto); }
  @Patch(":organizationId/locations/:locationId") updateLocation(@Req() req: AuthenticatedRequest, @Param("organizationId", ParseUUIDPipe) id: string, @Param("locationId", ParseUUIDPipe) locationId: string, @Body() dto: LocationUpdateDto) { return this.workforce.updateLocation(req.user, id, locationId, dto); }
  @Post(":organizationId/attendance/:attendanceId/correction") correctAttendance(@Req() req: AuthenticatedRequest, @Param("organizationId", ParseUUIDPipe) id: string, @Param("attendanceId", ParseUUIDPipe) attendanceId: string, @Body() dto: CorrectionDto) { return this.workforce.correctAttendance(req.user, id, attendanceId, dto); }
}
