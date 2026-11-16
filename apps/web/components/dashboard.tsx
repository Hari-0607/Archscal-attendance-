"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";

type Membership = { id: string; employeeNumber: string; fullName: string; email: string; role: "EMPLOYEE" | "ADMINISTRATOR"; wfhEnabled: boolean; department: { id: string; name: string } | null; organization: { id: string; name: string; timezone: string } };
type Attendance = { id: string; employeeId: string; workDate: string; checkInAt: string | null; checkOutAt: string | null; status: string; attendanceType: string; totalWorkMinutes: number | null; employee?: { fullName: string; employeeNumber: string; department?: { name: string } | null } };
type Employee = { id: string; employeeNumber: string; fullName: string; email: string; role: string; status: string; wfhEnabled: boolean; department: { id: string; name: string } | null };
type Department = { id: string; name: string };
type Location = { id: string; name: string; latitude: number | string; longitude: number | string; radiusMeters: number; active: boolean };
type Dashboard = { date: string; totals: { employees: number; present: number; absent: number; wfh: number; late: number }; records: Attendance[]; recordsTruncated: boolean };
type Tab = "attendance" | "people" | "settings";
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
let singleton: SupabaseClient | null = null;
function authClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return singleton ??= createClient(url, key, { auth: { flowType: "pkce", autoRefreshToken: true, persistSession: true, detectSessionInUrl: true } });
}
const today = () => new Intl.DateTimeFormat("en-CA").format(new Date());
const when = (value: string | null) => value ? new Date(value).toLocaleString() : "—";
const newKey = () => globalThis.crypto.randomUUID();

export default function Dashboard() {
  const [client, setClient] = useState<SupabaseClient | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [organizationId, setOrganizationId] = useState("");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [history, setHistory] = useState<Attendance[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [tab, setTab] = useState<Tab>("attendance");
  const [date, setDate] = useState(today());
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [inviteCode, setInviteCode] = useState("");

  useEffect(() => {
    const browserClient = authClient();
    if (!browserClient) { setAuthReady(true); return; }
    setClient(browserClient);
    void browserClient.auth.getSession().then(({ data }) => setUser(data.session?.user ?? null)).finally(() => setAuthReady(true));
    const { data } = browserClient.auth.onAuthStateChange((_event, session) => { setUser(session?.user ?? null); setAuthReady(true); });
    return () => data.subscription.unsubscribe();
  }, []);

  const request = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    if (!client) throw new Error("Authentication is not configured.");
    const { data } = await client.auth.getSession();
    if (!data.session?.access_token) throw new Error("Your session expired. Sign in again.");
    const response = await fetch(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${data.session.access_token}`, ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(Array.isArray(payload?.message) ? payload.message.join("; ") : payload?.message ?? `Request failed (${response.status})`);
    return payload as T;
  }, [client]);

  const refresh = useCallback(async () => {
    if (!user) return;
    const rows = await request<Membership[]>("/workforce/me");
    setMemberships(rows);
    const selected = rows.some((row) => row.organization.id === organizationId) ? organizationId : rows[0]?.organization.id ?? "";
    setOrganizationId(selected);
    if (!selected) { setDashboard(null); return; }
    const current = rows.find((row) => row.organization.id === selected)!;
    const [summary, historyRows] = await Promise.all([
      current.role === "ADMINISTRATOR" ? request<Dashboard>(`/workforce/${selected}/dashboard?date=${encodeURIComponent(date)}`) : Promise.resolve(null),
      request<Attendance[]>(`/workforce/${selected}/attendance?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    ]);
    setDashboard(summary);
    setHistory(historyRows);
    if (current.role === "ADMINISTRATOR") {
      const [employeeRows, departmentRows, locationRows] = await Promise.all([
        request<Employee[]>(`/workforce/${selected}/employees`), request<Department[]>(`/workforce/${selected}/departments`), request<Location[]>(`/workforce/${selected}/locations`),
      ]);
      setEmployees(employeeRows); setDepartments(departmentRows); setLocations(locationRows);
    }
  }, [user, organizationId, date, from, to, request]);

  useEffect(() => { if (!user) { setMemberships([]); setOrganizationId(""); setInviteCode(""); return; } void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : "Unable to load workspace")); }, [user, refresh]);

  const run = async (operation: () => Promise<unknown>, success: string) => {
    setBusy(true); setError(""); setNotice("");
    try { await operation(); setNotice(success); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Request failed"); }
    finally { setBusy(false); }
  };

  const submitAuth = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!client) return;
    const form = new FormData(event.currentTarget, (event.nativeEvent as SubmitEvent).submitter as HTMLElement | null); setBusy(true); setError(""); setNotice("");
    try {
      const email = String(form.get("email")); const password = String(form.get("password"));
      if (form.get("action") === "register") {
        const { error: authError } = await client.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } });
        if (authError) throw authError;
        setNotice("Check your inbox to verify your email, then sign in.");
      } else {
        const { error: authError } = await client.auth.signInWithPassword({ email, password });
        if (authError) throw authError;
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Authentication failed"); }
    finally { setBusy(false); }
  };

  const createOrganization = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    void run(async () => { await request("/workforce/organizations", { method: "POST", body: JSON.stringify({ name: form.get("name"), timezone: form.get("timezone") }) }); }, "Organization created.");
  };

  const redeemInvite = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    void run(async () => { await request("/workforce/invites/redeem", { method: "POST", body: JSON.stringify({ inviteCode: form.get("inviteCode"), fullName: form.get("fullName"), phone: form.get("phone") || undefined }) }); }, "Invitation accepted.");
  };

  const attendanceAction = async (kind: "check-in" | "check-out", attendanceType?: "OFFICE" | "REMOTE") => {
    const membership = memberships.find((row) => row.organization.id === organizationId);
    if (!membership) return;
    await run(async () => {
      let position: GeolocationPosition | null = null;
      const effectiveType = kind === "check-out" ? openAttendance?.attendanceType : attendanceType;
      if (effectiveType !== "REMOTE" && navigator.geolocation) {
        position = await new Promise<GeolocationPosition>((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 }));
      }
      await request(`/workforce/attendance/${kind}`, {
        method: "POST", headers: { "Idempotency-Key": newKey() },
        body: JSON.stringify({ organizationId, ...(attendanceType ? { attendanceType } : {}), ...(position ? { latitude: position.coords.latitude, longitude: position.coords.longitude, accuracyMeters: position.coords.accuracy } : {}) }),
      });
    }, kind === "check-in" ? "Check-in recorded." : "Check-out recorded.");
  };

  if (!authReady) return <main className="grid min-h-screen place-items-center text-sm text-slate-500">Loading AttendFlow…</main>;
  if (!client) return <main className="mx-auto max-w-xl p-8"><h1 className="text-xl font-bold">AttendFlow setup required</h1><p className="mt-2 text-sm text-slate-600">Set the Supabase URL and public key, plus the API URL, in the web app environment.</p></main>;
  if (!user) return <main className="grid min-h-screen place-items-center bg-slate-50 p-5"><form onSubmit={submitAuth} className="w-full max-w-md space-y-4 rounded-2xl border bg-white p-8 shadow-sm"><div><h1 className="text-2xl font-bold">AttendFlow</h1><p className="mt-1 text-sm text-slate-500">Secure employee attendance</p></div>{error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}{notice && <p role="status" className="rounded-lg bg-green-50 p-3 text-sm text-green-700">{notice}</p>}<label className="block text-sm">Email<input required type="email" name="email" autoComplete="email" className="mt-1 w-full rounded-lg border p-3"/></label><label className="block text-sm">Password<input required minLength={12} type="password" name="password" autoComplete="current-password" className="mt-1 w-full rounded-lg border p-3"/></label><div className="flex gap-3"><button name="action" value="login" disabled={busy} className="flex-1 rounded-lg bg-blue-700 p-3 font-semibold text-white">Sign in</button><button name="action" value="register" disabled={busy} className="flex-1 rounded-lg border p-3 font-semibold">Register</button></div><p className="text-xs text-slate-500">Supabase Auth enforces password policy and email verification.</p></form></main>;

  const membership = memberships.find((row) => row.organization.id === organizationId);
  const admin = membership?.role === "ADMINISTRATOR";
  const openAttendance = history.find((record) => record.employeeId === membership?.id && record.checkInAt && !record.checkOutAt);
  const exportCsv = () => {
    const columns = ["workDate", "employeeId", "status", "attendanceType", "checkInAt", "checkOutAt", "totalWorkMinutes"] as const;
    const csv = [columns.join(","), ...history.map((row) => columns.map((column) => `"${String(row[column] ?? "").replaceAll('"', '""')}"`).join(","))].join("\r\n");
    const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); link.download = `attendance-${from}-${to}.csv`; link.click(); URL.revokeObjectURL(link.href);
  };

  return <main className="min-h-screen bg-slate-50 text-slate-900"><header className="flex flex-wrap items-center justify-between gap-3 border-b bg-white px-5 py-4 md:px-10"><div><h1 className="text-lg font-bold">AttendFlow</h1><p className="text-xs text-slate-500">{membership ? `${membership.organization.name} · ${membership.fullName}` : user.email}</p></div><div className="flex items-center gap-3">{memberships.length > 1 && <select value={organizationId} onChange={(event) => setOrganizationId(event.target.value)} className="rounded-lg border p-2 text-sm">{memberships.map((row) => <option key={row.id} value={row.organization.id}>{row.organization.name}</option>)}</select>}<button onClick={() => void client.auth.signOut()} className="rounded-lg border px-3 py-2 text-sm">Sign out</button></div></header>
    <div className="mx-auto max-w-6xl p-5 md:p-10">{error && <p role="alert" className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}<button className="float-right" onClick={() => setError("")}>Dismiss</button></p>}{notice && <p role="status" className="mb-4 rounded-lg bg-green-50 p-3 text-sm text-green-700">{notice}</p>}
      {!memberships.length ? <div className="grid gap-5 md:grid-cols-2"><form onSubmit={createOrganization} className="space-y-3 rounded-2xl border bg-white p-6"><h2 className="font-bold">Create an organization</h2><input required minLength={2} maxLength={160} name="name" placeholder="Organization name" className="w-full rounded-lg border p-3"/><label className="block text-sm">Organization time zone<input required name="timezone" defaultValue="UTC" placeholder="Asia/Kolkata" className="mt-1 w-full rounded-lg border p-3"/></label><button disabled={busy} className="rounded-lg bg-blue-700 px-4 py-3 font-semibold text-white">Create organization</button></form><form onSubmit={redeemInvite} className="space-y-3 rounded-2xl border bg-white p-6"><h2 className="font-bold">Join by invitation</h2><input required minLength={32} name="inviteCode" placeholder="Invitation code" className="w-full rounded-lg border p-3"/><input required minLength={2} maxLength={160} name="fullName" placeholder="Full name" className="w-full rounded-lg border p-3"/><input name="phone" maxLength={32} placeholder="Phone (optional)" className="w-full rounded-lg border p-3"/><button disabled={busy} className="rounded-lg border px-4 py-3 font-semibold">Accept invitation</button><p className="text-xs text-slate-500">Use the verified email address the invitation was sent to.</p></form></div> : <>
        <nav className="mb-6 flex gap-2">{(["attendance", ...(admin ? ["people", "settings"] : [])] as Tab[]).map((item) => <button key={item} onClick={() => setTab(item)} className={`rounded-lg px-4 py-2 text-sm font-semibold capitalize ${tab === item ? "bg-blue-700 text-white" : "border bg-white"}`}>{item}</button>)}</nav>
        {tab === "attendance" && <section className="space-y-6"><div className="grid gap-3 sm:grid-cols-2">{admin && dashboard && Object.entries({ Present: dashboard.totals.present, Absent: dashboard.totals.absent, WFH: dashboard.totals.wfh, Late: dashboard.totals.late }).map(([label, value]) => <div key={label} className="rounded-xl border bg-white p-5"><div className="text-sm text-slate-500">{label} today</div><div className="mt-1 text-3xl font-bold">{value}</div></div>)}</div><div className="rounded-2xl border bg-white p-5"><h2 className="font-bold">Attendance actions</h2><p className="mt-1 text-sm text-slate-500">Office check-in/out requires a fresh GPS fix within an active office radius.</p><div className="mt-4 flex flex-wrap gap-3">{!openAttendance ? <><button disabled={busy} onClick={() => void attendanceAction("check-in", "OFFICE")} className="rounded-lg bg-blue-700 px-4 py-3 font-semibold text-white">Office check-in</button>{membership?.wfhEnabled && <button disabled={busy} onClick={() => void attendanceAction("check-in", "REMOTE")} className="rounded-lg border px-4 py-3 font-semibold">WFH check-in</button>}</> : <button disabled={busy} onClick={() => void attendanceAction("check-out")} className="rounded-lg bg-slate-900 px-4 py-3 font-semibold text-white">Check out</button>}</div></div><div className="rounded-2xl border bg-white p-5"><div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="font-bold">Attendance history</h2><div className="mt-3 flex gap-2"><label className="text-xs">From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="mt-1 block rounded border p-2"/></label><label className="text-xs">To<input type="date" value={to} onChange={(event) => setTo(event.target.value)} className="mt-1 block rounded border p-2"/></label></div></div><div className="flex gap-2">{admin && <label className="text-xs">Dashboard date<input type="date" value={date} onChange={(event) => setDate(event.target.value)} className="mt-1 block rounded border p-2"/></label>}<button onClick={exportCsv} className="rounded-lg border px-3 py-2 text-sm">Export CSV</button><button onClick={() => void refresh()} className="rounded-lg border px-3 py-2 text-sm">Refresh</button></div></div><div className="mt-4 overflow-x-auto"><table className="w-full min-w-[700px] text-left text-sm"><thead className="text-xs uppercase text-slate-500"><tr>{[...(admin ? ["Employee"] : []), "Date", "Mode", "Status", "Check in", "Check out", "Minutes"].map((label) => <th key={label} className="border-b px-3 py-3">{label}</th>)}</tr></thead><tbody>{history.map((row) => <tr key={row.id} className="border-b last:border-0">{admin && <td className="px-3 py-3">{row.employee?.fullName ?? "—"}</td>}<td className="px-3 py-3">{row.workDate.slice(0, 10)}</td><td className="px-3 py-3">{row.attendanceType}</td><td className="px-3 py-3">{row.status}</td><td className="px-3 py-3">{when(row.checkInAt)}</td><td className="px-3 py-3">{when(row.checkOutAt)}</td><td className="px-3 py-3">{row.totalWorkMinutes ?? "—"}</td></tr>)}</tbody></table>{!history.length && <p className="p-6 text-center text-sm text-slate-500">No attendance records for this date range.</p>}</div></div></section>}
        {tab === "people" && admin && <section className="space-y-6"><form onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); void run(async () => { const invite = await request<{ inviteCode: string }>(`/workforce/invites/${organizationId}`, { method: "POST", body: JSON.stringify({ email: form.get("email"), employeeNumber: form.get("employeeNumber"), designation: form.get("designation"), departmentId: form.get("departmentId") || undefined }) }); setInviteCode(invite.inviteCode); }, "Invitation created."); }} className="grid gap-3 rounded-2xl border bg-white p-5 sm:grid-cols-2 lg:grid-cols-5"><h2 className="font-bold sm:col-span-2 lg:col-span-5">Invite employee</h2><input required type="email" name="email" placeholder="Work email" className="rounded-lg border p-3"/><input required name="employeeNumber" maxLength={40} placeholder="Employee number" className="rounded-lg border p-3"/><input required name="designation" maxLength={120} placeholder="Designation" className="rounded-lg border p-3"/><select name="departmentId" className="rounded-lg border p-3"><option value="">No department</option>{departments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button disabled={busy} className="rounded-lg bg-blue-700 p-3 font-semibold text-white">Create invite</button></form>{inviteCode && <div className="break-all rounded-xl border border-amber-300 bg-amber-50 p-4"><p className="font-semibold">One-time invite code</p><code className="my-2 block select-all text-sm">{inviteCode}</code><button onClick={() => { if (!navigator.clipboard) { setError("Clipboard access is unavailable; select and copy the invitation code."); return; } void navigator.clipboard.writeText(inviteCode).then(() => setNotice("Invitation code copied.")).catch(() => setError("Could not copy the invitation code; select and copy it manually.")); }} className="rounded border bg-white px-3 py-2 text-sm">Copy code</button><p className="mt-2 text-xs text-slate-600">Share this code securely with the invited employee. It is shown only in this session.</p></div>}<div className="overflow-x-auto rounded-2xl border bg-white p-5"><h2 className="mb-4 font-bold">Employees</h2><table className="w-full min-w-[650px] text-left text-sm"><thead><tr className="text-xs uppercase text-slate-500">{["Employee", "Number", "Department", "Status", "WFH"].map((item) => <th key={item} className="border-b px-3 py-3">{item}</th>)}</tr></thead><tbody>{employees.map((person) => <tr key={person.id} className="border-b"><td className="px-3 py-3">{person.fullName}<div className="text-xs text-slate-500">{person.email}</div></td><td className="px-3 py-3">{person.employeeNumber}</td><td className="px-3 py-3">{person.department?.name ?? "—"}</td><td className="px-3 py-3">{person.status}</td><td className="px-3 py-3"><button disabled={busy || person.status !== "ACTIVE"} onClick={() => void run(() => request(`/workforce/${organizationId}/employees/${person.id}/wfh`, { method: "PATCH", body: JSON.stringify({ enabled: !person.wfhEnabled }) }), `WFH ${person.wfhEnabled ? "disabled" : "enabled"} for ${person.fullName}.`)} className="rounded border px-3 py-1">{person.wfhEnabled ? "Enabled" : "Enable"}</button></td></tr>)}</tbody></table></div></section>}
        {tab === "settings" && admin && <section className="grid gap-5 md:grid-cols-2"><form onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); void run(() => request(`/workforce/${organizationId}/departments`, { method: "POST", body: JSON.stringify({ name: form.get("name"), description: form.get("description") || undefined }) }), "Department added."); }} className="space-y-3 rounded-2xl border bg-white p-5"><h2 className="font-bold">Department management</h2><input required name="name" maxLength={120} placeholder="Department name" className="w-full rounded-lg border p-3"/><input name="description" maxLength={500} placeholder="Description" className="w-full rounded-lg border p-3"/><button disabled={busy} className="rounded-lg bg-blue-700 px-4 py-3 font-semibold text-white">Add department</button><ul className="list-inside list-disc text-sm text-slate-600">{departments.map((item) => <li key={item.id}>{item.name}</li>)}</ul></form><form onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); void run(() => request(`/workforce/${organizationId}/locations`, { method: "POST", body: JSON.stringify({ name: form.get("name"), latitude: Number(form.get("latitude")), longitude: Number(form.get("longitude")), radiusMeters: Number(form.get("radiusMeters")) }) }), "Office location saved."); }} className="space-y-3 rounded-2xl border bg-white p-5"><h2 className="font-bold">Office geofences</h2><input required name="name" maxLength={120} placeholder="Location name" className="w-full rounded-lg border p-3"/><div className="grid grid-cols-2 gap-2"><input required type="number" step="any" min="-90" max="90" name="latitude" placeholder="Latitude" className="rounded-lg border p-3"/><input required type="number" step="any" min="-180" max="180" name="longitude" placeholder="Longitude" className="rounded-lg border p-3"/></div><input required type="number" min="20" max="10000" name="radiusMeters" defaultValue="100" placeholder="Radius (meters)" className="w-full rounded-lg border p-3"/><button disabled={busy} className="rounded-lg bg-blue-700 px-4 py-3 font-semibold text-white">Add office location</button><ul className="space-y-2 text-sm text-slate-600">{locations.map((item) => <li key={item.id}>{item.name} · {item.radiusMeters} m</li>)}</ul></form></section>}
      </>}</div></main>;
}
