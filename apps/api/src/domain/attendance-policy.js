"use strict";

function parseDateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

function localDateKey(value, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const fields = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const values = [lat1, lon1, lat2, lon2];
  if (!values.every(Number.isFinite) || Math.abs(lat1) > 90 || Math.abs(lat2) > 90 || Math.abs(lon1) > 180 || Math.abs(lon2) > 180) {
    throw new RangeError("Coordinates are outside the valid latitude/longitude range");
  }
  const radians = (degrees) => degrees * Math.PI / 180;
  const latitudeDelta = radians(lat2 - lat1);
  const longitudeDelta = radians(lon2 - lon1);
  const raw = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(longitudeDelta / 2) ** 2;
  const haversine = Math.min(1, Math.max(0, raw));
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function matchOffice(locations, latitude, longitude) {
  return locations
    .filter((location) => location.active)
    .map((location) => ({
      location,
      distanceMeters: distanceMeters(Number(location.latitude), Number(location.longitude), latitude, longitude),
    }))
    .filter(({ location, distanceMeters: distance }) => distance <= location.radiusMeters)
    .sort((left, right) => left.distanceMeters - right.distanceMeters)[0] ?? null;
}

function workMinutes(start, end) {
  const from = start instanceof Date ? start.getTime() : Date.parse(start);
  const to = end instanceof Date ? end.getTime() : Date.parse(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  return Math.floor((to - from) / 60_000);
}

function summarizeDaily(activeEmployeeCount, records) {
  const counted = records.filter((record) => record.status !== "ABSENT" && record.status !== "LEAVE");
  return {
    employees: activeEmployeeCount,
    present: counted.length,
    absent: Math.max(0, activeEmployeeCount - records.length),
    wfh: records.filter((record) => record.attendanceType === "REMOTE").length,
    late: records.filter((record) => record.status === "LATE").length,
  };
}

module.exports = { parseDateOnly, localDateKey, distanceMeters, matchOffice, workMinutes, summarizeDaily };
