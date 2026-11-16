export type OfficeLocation = {
  id: string;
  latitude: number | string | { toString(): string };
  longitude: number | string | { toString(): string };
  radiusMeters: number;
  active: boolean;
};

export type AttendanceSummaryRecord = {
  status: string;
  attendanceType: string;
};

export function parseDateOnly(value: string): Date | null;
export function localDateKey(value: Date, timeZone: string): string;
export function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number;
export function matchOffice(locations: OfficeLocation[], latitude: number, longitude: number): { location: OfficeLocation; distanceMeters: number } | null;
export function workMinutes(start: Date | string, end: Date | string): number | null;
export function summarizeDaily(activeEmployeeCount: number, records: AttendanceSummaryRecord[]): { employees: number; present: number; absent: number; wfh: number; late: number };
