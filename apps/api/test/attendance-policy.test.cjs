"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseDateOnly,
  localDateKey,
  distanceMeters,
  matchOffice,
  workMinutes,
  summarizeDaily,
} = require("../src/domain/attendance-policy.js");

test("date-only parsing rejects invalid and normalized calendar dates", () => {
  assert.equal(parseDateOnly("2026-11-16").toISOString(), "2026-11-16T00:00:00.000Z");
  assert.equal(parseDateOnly("2026-02-30"), null);
  assert.equal(parseDateOnly("2026-2-03"), null);
  assert.equal(parseDateOnly("2026-01-01T00:00:00Z"), null);
});

test("work date is derived in the organization's time zone", () => {
  const justAfterMidnightUtc = new Date("2026-11-15T18:45:00.000Z");
  assert.equal(localDateKey(justAfterMidnightUtc, "Asia/Kolkata"), "2026-11-16");
  assert.equal(localDateKey(justAfterMidnightUtc, "America/Los_Angeles"), "2026-11-15");
  assert.throws(() => localDateKey(justAfterMidnightUtc, "not-a-time-zone"), RangeError);
});

test("geofence distance is symmetric, bounded, and rejects invalid coordinates", () => {
  const distance = distanceMeters(12.9716, 77.5946, 12.9725, 77.5946);
  assert.ok(distance > 95 && distance < 105);
  assert.equal(distanceMeters(12.9716, 77.5946, 12.9716, 77.5946), 0);
  assert.ok(Math.abs(distance - distanceMeters(12.9725, 77.5946, 12.9716, 77.5946)) < 0.001);
  assert.throws(() => distanceMeters(91, 0, 0, 0), RangeError);
});

test("office selection chooses the nearest active matching geofence", () => {
  const locations = [
    { id: "inactive", latitude: 0, longitude: 0, radiusMeters: 500, active: false },
    { id: "near", latitude: 12.9716, longitude: 77.5946, radiusMeters: 200, active: true },
    { id: "far", latitude: 12.9716, longitude: 77.5956, radiusMeters: 300, active: true },
  ];
  assert.equal(matchOffice(locations, 12.9716, 77.5946).location.id, "near");
  assert.equal(matchOffice(locations, 0, 0), null);
});

test("work duration rejects reversed and invalid timestamps", () => {
  assert.equal(workMinutes("2026-11-16T09:00:00Z", "2026-11-16T17:30:00Z"), 510);
  assert.equal(workMinutes("bad", "also bad"), null);
  assert.equal(workMinutes("2026-11-16T17:00:00Z", "2026-11-16T09:00:00Z"), null);
});

test("daily summary excludes leave and absent records from present totals", () => {
  assert.deepEqual(summarizeDaily(5, [
    { status: "PRESENT", attendanceType: "OFFICE" },
    { status: "LATE", attendanceType: "REMOTE" },
    { status: "LEAVE", attendanceType: "OFFICE" },
  ]), { employees: 5, present: 2, absent: 2, wfh: 1, late: 1 });
});
