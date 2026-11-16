import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  AttendanceStatus,
  AttendanceType,
  EmployeeRole,
  Prisma,
} from "@prisma/client";
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { AuthenticatedUser } from "../auth/authenticated-user";
import {
  localDateKey,
  parseDateOnly,
} from "../domain/attendance-policy.js";
import { PrismaService } from "../prisma.service";

type Tx = Prisma.TransactionClient;
type AttendanceInput = {
  organizationId: string;
  latitude?: number;
  longitude?: number;
  accuracyMeters?: number;
  attendanceType?: AttendanceType;
};
type AttendanceRange = { from?: string; to?: string; employeeId?: string };

@Injectable()
export class WorkforceService {
  constructor(private readonly prisma: PrismaService) {}

  private run<T>(user: AuthenticatedUser, action: (tx: Tx) => Promise<T>) {
    return this.prisma.withAuthenticatedUser(user, action);
  }

  private async requireMember(tx: Tx, user: AuthenticatedUser, organizationId: string, admin = false) {
    const employee = await tx.employee.findFirst({
      where: { supabaseUserId: user.id, organizationId, status: "ACTIVE" },
      include: { organization: true },
    });
    if (!employee) throw new NotFoundException("Organization membership not found");
    if (admin && employee.role !== EmployeeRole.ADMINISTRATOR) {
      throw new ForbiddenException("Administrator access is required");
    }
    return employee;
  }

  async me(user: AuthenticatedUser) {
    return this.run(user, (tx) => tx.employee.findMany({
      where: { supabaseUserId: user.id, status: "ACTIVE" },
      select: {
        id: true,
        employeeNumber: true,
        fullName: true,
        email: true,
        designation: true,
        role: true,
        wfhEnabled: true,
        department: { select: { id: true, name: true } },
        organization: { select: { id: true, name: true, timezone: true } },
      },
      orderBy: { createdAt: "asc" },
    }));
  }

  async createOrganization(user: AuthenticatedUser, input: { name: string; timezone: string }) {
    if (!user.emailVerified || !user.email) throw new ForbiddenException("Verify your email before creating an organization");
    try { new Intl.DateTimeFormat("en-US", { timeZone: input.timezone }); }
    catch { throw new BadRequestException("Unknown time zone"); }
    const name = this.requiredText(input.name, "Organization name", 2, 160);
    const slug = `${name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 55) || "workforce"}-${randomBytes(3).toString("hex")}`;
    const employeeNumber = `OWNER-${randomBytes(4).toString("hex").toUpperCase()}`;
    return this.run(user, async (tx) => {
      const ids = await tx.$queryRaw<Array<{ organization_id: string; employee_id: string }>>`
        SELECT organization_id, employee_id
        FROM public.create_organization_for_current_user(
          ${name}, ${slug}, ${input.timezone}, ${employeeNumber}, ${name}, ${user.email}, 'Administrator'
        )`;
      const pair = ids[0];
      if (!pair) throw new ConflictException("Organization could not be created");
      return tx.organization.findUniqueOrThrow({
        where: { id: pair.organization_id },
        select: { id: true, name: true, slug: true, timezone: true },
      });
    });
  }

  async createInvite(user: AuthenticatedUser, organizationId: string, input: {
    email: string; employeeNumber: string; designation: string; departmentId?: string;
  }) {
    const code = randomBytes(32).toString("base64url");
    const email = input.email.trim().toLowerCase();
    const employeeNumber = this.requiredText(input.employeeNumber, "Employee number", 1, 40);
    const designation = this.requiredText(input.designation, "Designation", 2, 120);
    try {
      const invite = await this.run(user, async (tx) => {
        const admin = await this.requireMember(tx, user, organizationId, true);
        const existing = await tx.organizationInvite.findFirst({ where: { organizationId, email, redeemedAt: null } });
        const data = {
            organizationId,
            email,
            employeeNumber,
            designation,
            departmentId: input.departmentId,
            codeHash: createHash("sha256").update(code).digest("hex"),
            createdByEmployeeId: admin.id,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          };
        return existing
          ? tx.organizationInvite.update({ where: { id: existing.id }, data, select: { id: true, email: true, expiresAt: true } })
          : tx.organizationInvite.create({ data, select: { id: true, email: true, expiresAt: true } });
      });
      return { ...invite, inviteCode: code };
    } catch (error) {
      if (this.prismaCode(error) === "P2002") throw new ConflictException("An active invitation already exists for this email");
      if (this.prismaCode(error) === "P2003") throw new BadRequestException("The selected department does not belong to this organization");
      throw error;
    }
  }

  async redeemInvite(user: AuthenticatedUser, input: { inviteCode: string; fullName: string; phone?: string }) {
    if (!user.emailVerified || !user.email) throw new ForbiddenException("Verify the invited email address before registration");
    const fullName = this.requiredText(input.fullName, "Full name", 2, 160);
    const phone = input.phone == null ? null : this.requiredText(input.phone, "Phone number", 1, 32);
    const codeHash = createHash("sha256").update(input.inviteCode).digest("hex");
    return this.run(user, async (tx) => {
      const redeemed = await tx.$queryRaw<Array<{ employee_id: string }>>`
        SELECT public.redeem_employee_invite(
          ${codeHash}, ${fullName}, ${phone}
        ) AS employee_id`;
      const employeeId = redeemed[0]?.employee_id;
      if (!employeeId) throw new ConflictException("Invitation is invalid, expired, or already redeemed");
      return tx.employee.findUniqueOrThrow({
        where: { id: employeeId },
        select: { id: true, fullName: true, email: true, role: true, organizationId: true },
      });
    });
  }

  async dashboard(user: AuthenticatedUser, organizationId: string, date?: string) {
    return this.run(user, async (tx) => {
      const admin = await this.requireMember(tx, user, organizationId, true);
      const key = date ? parseDateOnly(date) : parseDateOnly(localDateKey(new Date(), admin.organization.timezone));
      if (!key) throw new BadRequestException("Date must be a valid YYYY-MM-DD value");
      const [employeeCount, records, groups] = await Promise.all([
        tx.employee.count({ where: { organizationId, status: "ACTIVE" } }),
        tx.attendanceRecord.findMany({
          where: { organizationId, workDate: key },
          include: { employee: { select: { id: true, fullName: true, employeeNumber: true, designation: true, department: { select: { name: true } } } } },
          orderBy: { checkInAt: "desc" },
          take: 1000,
        }),
        tx.attendanceRecord.groupBy({
          by: ["status", "attendanceType"],
          where: { organizationId, workDate: key },
          _count: { _all: true },
        }),
      ]);
      const count = (matches: (row: (typeof groups)[number]) => boolean) => groups.filter(matches).reduce((sum, row) => sum + row._count._all, 0);
      const totalRecordCount = groups.reduce((sum, row) => sum + row._count._all, 0);
      const present = count((row) => row.status !== AttendanceStatus.ABSENT && row.status !== AttendanceStatus.LEAVE);
      const leave = count((row) => row.status === AttendanceStatus.LEAVE);
      const totals = {
        employees: employeeCount,
        present,
        absent: Math.max(0, employeeCount - present - leave),
        wfh: count((row) => row.attendanceType === AttendanceType.REMOTE),
        late: count((row) => row.status === AttendanceStatus.LATE),
      };
      return { date: key.toISOString().slice(0, 10), totals, records, recordsTruncated: totalRecordCount > records.length };
    });
  }

  async attendance(user: AuthenticatedUser, organizationId: string, range: AttendanceRange = {}) {
    return this.run(user, async (tx) => {
      const member = await this.requireMember(tx, user, organizationId);
      const today = parseDateOnly(localDateKey(new Date(), member.organization.timezone))!;
      const start = range.from ? parseDateOnly(range.from) : new Date(today.getTime() - 29 * 86_400_000);
      const end = range.to ? parseDateOnly(range.to) : today;
      if (!start || !end || start > end) throw new BadRequestException("A valid date range is required");
      const days = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
      if (days > 366) throw new BadRequestException("Attendance searches are limited to 366 days");
      const employeeId = member.role === EmployeeRole.ADMINISTRATOR ? range.employeeId : member.id;
      if (range.employeeId && member.role !== EmployeeRole.ADMINISTRATOR) throw new ForbiddenException("Only administrators can search another employee");
      return tx.attendanceRecord.findMany({
        where: { organizationId, employeeId, workDate: { gte: start, lte: end } },
        include: member.role === EmployeeRole.ADMINISTRATOR ? { employee: { select: { fullName: true, employeeNumber: true, department: { select: { name: true } } } } } : undefined,
        orderBy: { workDate: "desc" },
        take: 1000,
      });
    });
  }

  async checkIn(user: AuthenticatedUser, input: AttendanceInput, idempotencyKey: string, ip?: string) {
    this.validateIdempotencyKey(idempotencyKey);
    return this.run(user, async (tx) => {
      const employee = await this.requireMember(tx, user, input.organizationId);
      const previous = await tx.attendanceEvent.findFirst({
        where: { organizationId: input.organizationId, employeeId: employee.id, requestId: idempotencyKey, type: "CHECK_IN" },
        select: { attendanceId: true },
      });
      if (previous?.attendanceId) return tx.attendanceRecord.findUniqueOrThrow({ where: { id: previous.attendanceId } });
      const type = input.attendanceType ?? AttendanceType.OFFICE;
      const settings = employee.organization.settings as { maxGpsAccuracyMeters?: number };
      if (type === AttendanceType.REMOTE && !employee.wfhEnabled) throw new ForbiddenException("Work from home is not enabled for this employee");
      if (type === AttendanceType.OFFICE) this.validateGps(input, settings.maxGpsAccuracyMeters ?? 100);
      const ipHash = this.hashIp(ip);
      try {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM public.attendance_check_in(
            ${input.organizationId}::uuid,
            ${input.latitude ?? null}::numeric,
            ${input.longitude ?? null}::numeric,
            ${input.accuracyMeters ?? null}::numeric,
            ${ipHash}::text, NULL::text, NULL::text,
            ${idempotencyKey}::text, ${type}::"AttendanceType"
          )`;
        if (!rows[0]) throw new ConflictException("Attendance check-in was not recorded");
        return tx.attendanceRecord.findUniqueOrThrow({ where: { id: rows[0].id } });
      } catch (error) { throw this.mapAttendanceError(error, "You have already checked in today"); }
    });
  }

  async checkOut(user: AuthenticatedUser, input: Omit<AttendanceInput, "attendanceType">, idempotencyKey: string, ip?: string) {
    this.validateIdempotencyKey(idempotencyKey);
    return this.run(user, async (tx) => {
      const employee = await this.requireMember(tx, user, input.organizationId);
      const previous = await tx.attendanceEvent.findFirst({
        where: { organizationId: input.organizationId, employeeId: employee.id, requestId: idempotencyKey, type: "CHECK_OUT" },
        select: { attendanceId: true },
      });
      if (previous?.attendanceId) return tx.attendanceRecord.findUniqueOrThrow({ where: { id: previous.attendanceId } });
      const current = await tx.attendanceRecord.findFirst({
        where: { organizationId: input.organizationId, employeeId: employee.id, checkInAt: { not: null }, checkOutAt: null },
        orderBy: { workDate: "desc" },
      });
      if (!current) throw new ConflictException("There is no open attendance record");
      const settings = employee.organization.settings as { maxGpsAccuracyMeters?: number };
      if (current.attendanceType === AttendanceType.OFFICE) this.validateGps(input, settings.maxGpsAccuracyMeters ?? 100);
      let rows: Array<{ id: string }>;
      try {
        rows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM public.attendance_check_out(
            ${input.organizationId}::uuid,
            ${input.latitude ?? null}::numeric,
            ${input.longitude ?? null}::numeric,
            ${this.hashIp(ip)}::text,
            NULL::text, NULL::text,
            ${idempotencyKey}::text,
            ${input.accuracyMeters ?? null}::numeric
          )`;
      } catch (error) { throw this.mapAttendanceError(error, "You have already checked out"); }
      if (!rows[0]) throw new ConflictException("Attendance check-out was not recorded");
      return tx.attendanceRecord.findUniqueOrThrow({ where: { id: rows[0].id } });
    });
  }

  async departments(user: AuthenticatedUser, organizationId: string) {
    return this.run(user, async (tx) => {
      await this.requireMember(tx, user, organizationId);
      return tx.department.findMany({ where: { organizationId }, orderBy: { name: "asc" } });
    });
  }

  async createDepartment(user: AuthenticatedUser, organizationId: string, input: { name: string; description?: string }) {
    const name = this.requiredText(input.name, "Department name", 2, 120);
    return this.run(user, async (tx) => {
      await this.requireMember(tx, user, organizationId, true);
      return tx.department.create({ data: { organizationId, name, description: input.description?.trim() || undefined } });
    });
  }

  async employees(user: AuthenticatedUser, organizationId: string) {
    return this.run(user, async (tx) => {
      await this.requireMember(tx, user, organizationId, true);
      return tx.employee.findMany({
        where: { organizationId },
        select: { id: true, employeeNumber: true, fullName: true, email: true, phone: true, designation: true, role: true, status: true, wfhEnabled: true, department: { select: { id: true, name: true } } },
        orderBy: { fullName: "asc" },
        take: 1000,
      });
    });
  }

  async setWfh(user: AuthenticatedUser, organizationId: string, employeeId: string, enabled: boolean) {
    return this.run(user, async (tx) => {
      await this.requireMember(tx, user, organizationId, true);
      const result = await tx.employee.updateMany({ where: { id: employeeId, organizationId, status: "ACTIVE" }, data: { wfhEnabled: enabled } });
      if (result.count !== 1) throw new NotFoundException("Active employee not found");
      return tx.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { id: true, wfhEnabled: true } });
    });
  }

  async updateEmployee(user: AuthenticatedUser, organizationId: string, employeeId: string, input: {
    fullName?: string | null; phone?: string | null; designation?: string | null; departmentId?: string | null; status?: "ACTIVE" | "DEACTIVATED" | null;
  }) {
    if (input.status === null) throw new BadRequestException("Employee status cannot be null");
    const status = input.status as "ACTIVE" | "DEACTIVATED" | undefined;
    if (input.phone !== undefined && input.phone !== null && typeof input.phone !== "string") throw new BadRequestException("Phone number is invalid");
    if (input.departmentId !== undefined && input.departmentId !== null && typeof input.departmentId !== "string") throw new BadRequestException("Department is invalid");
    const fullName = input.fullName === undefined ? undefined : this.requiredText(input.fullName, "Full name", 2, 160);
    const designation = input.designation === undefined ? undefined : this.requiredText(input.designation, "Designation", 2, 120);
    return this.run(user, async (tx) => {
      const admin = await this.requireMember(tx, user, organizationId, true);
      const current = await tx.employee.findFirst({ where: { id: employeeId, organizationId } });
      if (!current) throw new NotFoundException("Employee not found");
      if (current.role === EmployeeRole.ADMINISTRATOR && input.status === "DEACTIVATED") {
        const adminCount = await tx.employee.count({ where: { organizationId, role: EmployeeRole.ADMINISTRATOR, status: "ACTIVE" } });
        if (adminCount <= 1) throw new ConflictException("The organization must have at least one active administrator");
        if (current.id === admin.id) throw new ConflictException("Transfer administrator access before deactivating your account");
      }
      try {
        const data: Prisma.EmployeeUncheckedUpdateInput = {
          ...(fullName === undefined ? {} : { fullName }),
          ...(input.phone === undefined ? {} : { phone: input.phone?.trim() || null }),
          ...(designation === undefined ? {} : { designation }),
          ...(input.departmentId === undefined ? {} : { departmentId: input.departmentId }),
          ...(status === undefined ? {} : { status, deactivatedAt: status === "DEACTIVATED" ? new Date() : null }),
        };
        await tx.employee.update({
          where: { id: employeeId },
          data,
        });
      } catch (error) { if (this.prismaCode(error) === "P2003") throw new BadRequestException("The selected department does not belong to this organization"); throw error; }
      return tx.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { id: true, fullName: true, phone: true, designation: true, status: true, department: { select: { id: true, name: true } } } });
    });
  }

  async locations(user: AuthenticatedUser, organizationId: string) {
    return this.run(user, async (tx) => {
      const member = await this.requireMember(tx, user, organizationId);
      if (member.role === EmployeeRole.ADMINISTRATOR) return tx.officeLocation.findMany({ where: { organizationId, active: true }, orderBy: { name: "asc" } });
      return tx.officeLocation.findMany({ where: { organizationId, active: true }, select: { id: true, name: true, radiusMeters: true, active: true }, orderBy: { name: "asc" } });
    });
  }

  async createLocation(user: AuthenticatedUser, organizationId: string, input: {
    name: string; latitude: number; longitude: number; radiusMeters: number;
  }) {
    const name = this.requiredText(input.name, "Office location name", 2, 120);
    return this.run(user, async (tx) => {
      await this.requireMember(tx, user, organizationId, true);
      return tx.officeLocation.create({ data: { organizationId, name, latitude: input.latitude, longitude: input.longitude, radiusMeters: input.radiusMeters } });
    });
  }

  async updateLocation(user: AuthenticatedUser, organizationId: string, locationId: string, input: {
    name?: string | null; latitude?: number | null; longitude?: number | null; radiusMeters?: number | null; active?: boolean | null;
  }) {
    if (Object.values(input).some((value) => value === null)) throw new BadRequestException("Office location fields cannot be null");
    if (Object.values(input).every((value) => value === undefined)) throw new BadRequestException("Provide at least one office location field to update");
    const data: Prisma.OfficeLocationUpdateManyMutationInput = {
      ...(input.name === undefined ? {} : { name: this.requiredText(input.name, "Office location name", 2, 120) }),
      ...(input.latitude == null ? {} : { latitude: input.latitude }),
      ...(input.longitude == null ? {} : { longitude: input.longitude }),
      ...(input.radiusMeters == null ? {} : { radiusMeters: input.radiusMeters }),
      ...(input.active == null ? {} : { active: input.active }),
    };
    return this.run(user, async (tx) => {
      await this.requireMember(tx, user, organizationId, true);
      const result = await tx.officeLocation.updateMany({ where: { id: locationId, organizationId }, data });
      if (result.count !== 1) throw new NotFoundException("Office location not found");
      return tx.officeLocation.findUniqueOrThrow({ where: { id: locationId } });
    });
  }

  async correctAttendance(user: AuthenticatedUser, organizationId: string, attendanceId: string, input: {
    reason: string; checkInAt?: string; checkOutAt?: string | null; status?: AttendanceStatus;
  }) {
    const reason = this.requiredText(input.reason, "Correction reason", 5, 1000);
    if (input.checkInAt === undefined && input.checkOutAt === undefined) throw new BadRequestException("Provide a check-in or check-out timestamp to correct");
    return this.run(user, async (tx) => {
      await this.requireMember(tx, user, organizationId, true);
      const current = await tx.attendanceRecord.findFirst({ where: { id: attendanceId, organizationId } });
      if (!current) throw new NotFoundException("Attendance record not found");
      const checkInAt = input.checkInAt === undefined ? current.checkInAt : new Date(input.checkInAt);
      const checkOutAt = input.checkOutAt === undefined ? current.checkOutAt : input.checkOutAt ? new Date(input.checkOutAt) : null;
      if (!checkInAt || !Number.isFinite(checkInAt.getTime()) || (checkOutAt && (!Number.isFinite(checkOutAt.getTime()) || checkOutAt <= checkInAt))) throw new BadRequestException("Attendance timestamps are invalid");
      const status = input.status ?? (checkOutAt ? (current.lateMinutes > 0 ? AttendanceStatus.LATE : AttendanceStatus.PRESENT) : (current.lateMinutes > 0 ? AttendanceStatus.LATE : AttendanceStatus.IN_PROGRESS));
      const result = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM public.admin_correct_attendance(
          ${organizationId}::uuid, ${attendanceId}::uuid, ${checkInAt}::timestamptz,
          ${checkOutAt}::timestamptz, ${status}::"AttendanceStatus", ${reason}::text,
          NULL::text, NULL::text
        )`;
      if (!result[0]) throw new NotFoundException("Attendance record not found");
      return tx.attendanceRecord.findUniqueOrThrow({ where: { id: result[0].id } });
    });
  }

  private validateGps(input: AttendanceInput | Omit<AttendanceInput, "attendanceType">, maxAccuracy: number) {
    if (input.latitude == null || input.longitude == null || input.accuracyMeters == null) throw new BadRequestException("Fresh GPS coordinates and accuracy are required for office attendance");
    if (input.accuracyMeters <= 0 || input.accuracyMeters > maxAccuracy) throw new BadRequestException("GPS accuracy is too low; try again with a clearer signal");
    if (input.latitude < -90 || input.latitude > 90 || input.longitude < -180 || input.longitude > 180) throw new BadRequestException("GPS coordinates are invalid");
  }

  private validateIdempotencyKey(value: string) {
    if (!/^[A-Za-z0-9._:-]{16,80}$/.test(value)) throw new BadRequestException("A valid Idempotency-Key header is required");
  }

  private requiredText(value: unknown, field: string, min: number, max: number) {
    if (typeof value !== "string") throw new BadRequestException(`${field} is invalid`);
    const normalized = value.trim();
    if (normalized.length < min || normalized.length > max) throw new BadRequestException(`${field} must contain ${min} to ${max} characters`);
    return normalized;
  }

  private hashIp(ip?: string) {
    const secret = process.env.IP_HASH_SECRET;
    return secret && ip ? createHmac("sha256", secret).update(ip).digest("hex") : null;
  }

  private prismaCode(error: unknown) {
    return error instanceof Prisma.PrismaClientKnownRequestError ? error.code : undefined;
  }

  private mapAttendanceError(error: unknown, duplicateMessage: string): never {
    if (this.prismaCode(error) === "P2002" || this.prismaCode(error) === "P2010") {
      const meta = error instanceof Prisma.PrismaClientKnownRequestError ? error.meta : undefined;
      if (meta?.code === "23505" || this.prismaCode(error) === "P2002") throw new ConflictException(duplicateMessage);
    }
    if (this.prismaCode(error) === "P2010") {
      const databaseCode = (error as Prisma.PrismaClientKnownRequestError & { meta?: { code?: string } }).meta?.code;
      if (databaseCode === "42501") throw new ForbiddenException("Attendance is not allowed for this employee");
      if (databaseCode === "P0001") throw new BadRequestException("The attendance request did not meet the configured policy");
    }
    throw error;
  }
}

