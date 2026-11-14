create extension if not exists pgcrypto;

create type public.member_role as enum ('super_admin','admin','hr','manager','employee','auditor');
create type public.attendance_status as enum ('in_progress','present','late','early_exit','incomplete','corrected');
create type public.leave_status as enum ('pending','manager_approved','approved','rejected','cancelled');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text not null default '',
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 120),
  timezone text not null default 'UTC',
  settings jsonb not null default '{"allowed_attendance_types":["office"]}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.member_role not null default 'employee',
  employee_code text,
  active boolean not null default true,
  joined_at timestamptz not null default now(),
  unique (organization_id,user_id), unique (organization_id,employee_code)
);
create index members_user_active_idx on public.organization_members(user_id,active);

create table public.office_locations (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null, latitude double precision not null check(latitude between -90 and 90), longitude double precision not null check(longitude between -180 and 180),
  radius_meters integer not null default 100 check(radius_meters between 20 and 5000), geofence_required boolean not null default true, active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index office_locations_org_active_idx on public.office_locations(organization_id,active);

create table public.shifts (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null, start_time time not null, end_time time not null, grace_minutes integer not null default 5 check(grace_minutes between 0 and 240),
  break_minutes integer not null default 30 check(break_minutes between 0 and 480), active boolean not null default true, created_at timestamptz not null default now(),
  unique(organization_id,name)
);
create table public.employee_shifts (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade, shift_id uuid not null references public.shifts(id), work_date date not null,
  assigned_by uuid references public.profiles(id), created_at timestamptz not null default now(), unique(organization_id,user_id,work_date)
);
create index employee_shifts_org_date_idx on public.employee_shifts(organization_id,work_date);

create table public.attendance_records (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.profiles(id), attendance_date date not null, check_in_at timestamptz, check_out_at timestamptz,
  status public.attendance_status not null default 'in_progress', attendance_type text not null default 'office' check(attendance_type in ('office','hybrid','remote','field')),
  late_minutes integer not null default 0, early_exit_minutes integer not null default 0, overtime_minutes integer not null default 0,
  location_id uuid references public.office_locations(id), check_in_latitude double precision, check_in_longitude double precision,
  check_out_latitude double precision, check_out_longitude double precision, source text not null default 'self' check(source in ('self','qr','admin','device')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(organization_id,user_id,attendance_date)
);
create index attendance_org_date_idx on public.attendance_records(organization_id,attendance_date desc);
create index attendance_user_date_idx on public.attendance_records(user_id,attendance_date desc);
create table public.attendance_breaks (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
  attendance_id uuid not null references public.attendance_records(id) on delete cascade, user_id uuid not null references public.profiles(id),
  started_at timestamptz not null default now(), ended_at timestamptz, created_at timestamptz not null default now()
);
create index attendance_breaks_record_idx on public.attendance_breaks(attendance_id,started_at);
create table public.attendance_corrections (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), attendance_id uuid not null references public.attendance_records(id),
  changed_by uuid not null references public.profiles(id), reason text not null check(char_length(reason) >= 5), old_values jsonb not null, new_values jsonb not null, created_at timestamptz not null default now()
);

create table public.leave_requests (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.profiles(id), leave_type text not null check(leave_type in ('sick','vacation','casual','emergency','other')),
  start_date date not null, end_date date not null, reason text not null default '', status public.leave_status not null default 'pending',
  manager_id uuid references public.profiles(id), manager_decision_at timestamptz, manager_reason text,
  hr_id uuid references public.profiles(id), hr_decision_at timestamptz, hr_reason text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check(end_date >= start_date)
);
create index leave_org_status_date_idx on public.leave_requests(organization_id,status,start_date);

create table public.trusted_devices (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id) on delete cascade,
  organization_id uuid references public.organizations(id) on delete cascade, device_fingerprint_hash text not null,
  label text not null default 'Unknown device', user_agent text, trusted_at timestamptz, last_seen_at timestamptz not null default now(), revoked_at timestamptz, created_at timestamptz not null default now(),
  unique(user_id,device_fingerprint_hash)
);
create table public.workforce_events (
  id uuid primary key default gen_random_uuid(), organization_id uuid references public.organizations(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete set null, event_type text not null, occurred_at timestamptz not null default now(),
  ip_hash text, device_id uuid references public.trusted_devices(id) on delete set null, user_agent text, metadata jsonb not null default '{}'::jsonb
);
create index workforce_events_org_time_idx on public.workforce_events(organization_id,occurred_at desc);
create index workforce_events_user_time_idx on public.workforce_events(user_id,occurred_at desc);

create table public.audit_logs (
  id bigint generated always as identity primary key, organization_id uuid references public.organizations(id) on delete set null,
  actor_id uuid references public.profiles(id) on delete set null, action text not null, entity_type text not null, entity_id text,
  old_value jsonb, new_value jsonb, reason text, ip_hash text, device_id uuid, location jsonb,
  request_id text, created_at timestamptz not null default now()
);
create index audit_org_time_idx on public.audit_logs(organization_id,created_at desc);
create index audit_actor_time_idx on public.audit_logs(actor_id,created_at desc);
create table public.qr_challenges (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
  location_id uuid references public.office_locations(id), token_hash text not null unique, valid_from timestamptz not null,
  expires_at timestamptz not null, consumed_at timestamptz, consumed_by uuid references public.profiles(id), created_at timestamptz not null default now()
);
create index qr_challenges_expiry_idx on public.qr_challenges(expires_at) where consumed_at is null;
create table public.notification_outbox (
  id uuid primary key default gen_random_uuid(), organization_id uuid references public.organizations(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade, channel text not null check(channel in ('email','push','sms')),
  event_type text not null, payload jsonb not null, status text not null default 'pending' check(status in ('pending','processing','sent','failed')),
  attempts integer not null default 0, next_attempt_at timestamptz not null default now(), created_at timestamptz not null default now(), sent_at timestamptz
);

create or replace function public.is_org_member(p_org uuid) returns boolean language sql stable security definer set search_path=public,auth as $$
 select exists(select 1 from public.organization_members m where m.organization_id=p_org and m.user_id=auth.uid() and m.active)
$$;
create or replace function public.has_org_role(p_org uuid, p_roles public.member_role[]) returns boolean language sql stable security definer set search_path=public,auth as $$
 select exists(select 1 from public.organization_members m where m.organization_id=p_org and m.user_id=auth.uid() and m.active and (m.role=any(p_roles) or m.role='super_admin'))
$$;
revoke all on function public.is_org_member(uuid) from public;
revoke all on function public.has_org_role(uuid,public.member_role[]) from public;
grant execute on function public.is_org_member(uuid) to authenticated;
grant execute on function public.has_org_role(uuid,public.member_role[]) to authenticated;

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$ begin new.updated_at=now(); return new; end $$;
create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();
create trigger organizations_touch before update on public.organizations for each row execute function public.touch_updated_at();
create trigger attendance_touch before update on public.attendance_records for each row execute function public.touch_updated_at();
create trigger leave_touch before update on public.leave_requests for each row execute function public.touch_updated_at();
create or replace function public.capture_audit() returns trigger language plpgsql security definer set search_path=public,auth as $$
declare v_org uuid; v_id text; v_old jsonb; v_new jsonb; begin
 if TG_OP='DELETE' then v_org:=(to_jsonb(old)->>'organization_id')::uuid; v_id:=coalesce(to_jsonb(old)->>'id',''); v_old:=to_jsonb(old);
 elsif TG_OP='INSERT' then v_org:=(to_jsonb(new)->>'organization_id')::uuid; v_id:=coalesce(to_jsonb(new)->>'id',''); v_new:=to_jsonb(new);
 else v_org:=coalesce((to_jsonb(new)->>'organization_id')::uuid,(to_jsonb(old)->>'organization_id')::uuid); v_id:=coalesce(to_jsonb(new)->>'id',to_jsonb(old)->>'id',''); v_old:=to_jsonb(old); v_new:=to_jsonb(new); end if;
 insert into public.audit_logs(organization_id,actor_id,action,entity_type,entity_id,old_value,new_value)
 values(v_org,auth.uid(),lower(TG_OP),TG_TABLE_NAME,v_id,v_old,v_new);
 return coalesce(new,old);
end $$;
create trigger audit_attendance after insert or update or delete on public.attendance_records for each row execute function public.capture_audit();
create trigger audit_leave after insert or update or delete on public.leave_requests for each row execute function public.capture_audit();
create trigger audit_members after insert or update or delete on public.organization_members for each row execute function public.capture_audit();
create trigger audit_shifts after insert or update or delete on public.shifts for each row execute function public.capture_audit();
create or replace function public.block_audit_mutation() returns trigger language plpgsql as $$ begin raise exception 'audit log is append-only'; end $$;
create trigger audit_no_update before update or delete on public.audit_logs for each row execute function public.block_audit_mutation();

create or replace function public.on_auth_user_created() returns trigger language plpgsql security definer set search_path=public as $$
begin insert into public.profiles(id,email,full_name) values(new.id,new.email,coalesce(new.raw_user_meta_data->>'full_name','')) on conflict(id) do update set email=excluded.email; return new; end $$;
create trigger auth_user_profile after insert on auth.users for each row execute function public.on_auth_user_created();

create or replace function public.create_organization(p_name text,p_timezone text default 'UTC') returns public.organizations
language plpgsql security definer set search_path=public,auth as $$ declare v_org public.organizations; begin
 if auth.uid() is null then raise exception 'authentication required'; end if;
 if not exists(select 1 from pg_timezone_names where name=p_timezone) then raise exception 'invalid organization timezone'; end if;
 if not exists(select 1 from public.profiles where id=auth.uid()) then raise exception 'profile is not ready'; end if;
 insert into public.organizations(name,timezone) values(p_name,p_timezone) returning * into v_org;
 insert into public.organization_members(organization_id,user_id,role) values(v_org.id,auth.uid(),'admin'); return v_org;
end $$;
grant execute on function public.create_organization(text,text) to authenticated;

create or replace function public.distance_meters(lat1 double precision,lon1 double precision,lat2 double precision,lon2 double precision) returns double precision
language sql immutable strict as $$ select 6371000*2*asin(sqrt(power(sin(radians(lat2-lat1)/2),2)+cos(radians(lat1))*cos(radians(lat2))*power(sin(radians(lon2-lon1)/2),2))) $$;

create or replace function public.attendance_check_in(p_organization_id uuid,p_location_id uuid default null,p_latitude double precision default null,p_longitude double precision default null,p_qr_token text default null,p_attendance_type text default 'office') returns public.attendance_records
language plpgsql security definer set search_path=public,auth,extensions as $$
declare v_uid uuid:=auth.uid(); v_day date; v_org public.organizations; v_loc public.office_locations; v_qr public.qr_challenges; v_record public.attendance_records; v_tz text;
begin
 if v_uid is null or not public.is_org_member(p_organization_id) then raise exception 'organization membership required'; end if;
 if p_attendance_type not in ('office','hybrid','remote','field') then raise exception 'invalid attendance type'; end if;
 select * into v_org from public.organizations where id=p_organization_id; v_tz:=v_org.timezone; v_day:=(now() at time zone v_tz)::date;
 if not coalesce(v_org.settings->'allowed_attendance_types','["office"]'::jsonb) ? p_attendance_type then raise exception 'attendance type is not enabled by organization policy'; end if;
 if p_location_id is not null then
  select * into v_loc from public.office_locations where id=p_location_id and organization_id=p_organization_id and active;
  if not found then raise exception 'office location unavailable'; end if;
  if v_loc.geofence_required and (p_latitude is null or p_longitude is null or public.distance_meters(v_loc.latitude,v_loc.longitude,p_latitude,p_longitude)>v_loc.radius_meters) then raise exception 'outside the allowed attendance area'; end if;
 elsif p_attendance_type in ('office','hybrid') and exists(select 1 from public.office_locations where organization_id=p_organization_id and active and geofence_required) then
  if p_latitude is null or p_longitude is null then raise exception 'location permission is required'; end if;
  select * into v_loc from public.office_locations where organization_id=p_organization_id and active and geofence_required order by public.distance_meters(latitude,longitude,p_latitude,p_longitude) limit 1;
  if not found or public.distance_meters(v_loc.latitude,v_loc.longitude,p_latitude,p_longitude)>v_loc.radius_meters then raise exception 'outside the allowed attendance area'; end if;
  p_location_id:=v_loc.id;
 end if;
 if p_qr_token is not null then
  select * into v_qr from public.qr_challenges where organization_id=p_organization_id and token_hash=encode(digest(p_qr_token,'sha256'),'hex') and consumed_at is null and valid_from<=now() and expires_at>now() for update;
  if not found then raise exception 'QR challenge expired or already used'; end if;
  if v_qr.location_id is not null then
   if p_location_id is not null and p_location_id<>v_qr.location_id then raise exception 'QR challenge belongs to a different office'; end if;
   select * into v_loc from public.office_locations where id=v_qr.location_id and organization_id=p_organization_id and active;
   if v_loc.geofence_required and (p_latitude is null or p_longitude is null or public.distance_meters(v_loc.latitude,v_loc.longitude,p_latitude,p_longitude)>v_loc.radius_meters) then raise exception 'outside the QR office attendance area'; end if;
   p_location_id:=v_loc.id;
  end if;
  update public.qr_challenges set consumed_at=now(),consumed_by=v_uid where organization_id=p_organization_id and token_hash=encode(digest(p_qr_token,'sha256'),'hex') and consumed_at is null;
  if not found then raise exception 'QR challenge expired or already used'; end if;
 end if;
 declare
  v_shift public.shifts; v_assignment public.employee_shifts; v_late integer:=0;
 begin
  select es.* into v_assignment from public.employee_shifts es where es.organization_id=p_organization_id and es.user_id=v_uid and es.work_date=v_day limit 1;
  if found then
   select * into v_shift from public.shifts where id=v_assignment.shift_id;
   v_late:=greatest(0,floor(extract(epoch from ((now() at time zone v_tz)::time-v_shift.start_time))/60)::integer-v_shift.grace_minutes);
  end if;
  insert into public.attendance_records(organization_id,user_id,attendance_date,check_in_at,status,attendance_type,location_id,check_in_latitude,check_in_longitude,source,late_minutes)
  values(p_organization_id,v_uid,v_day,now(),case when v_late>0 then 'late'::public.attendance_status else 'in_progress'::public.attendance_status end,p_attendance_type,p_location_id,p_latitude,p_longitude,case when p_qr_token is null then 'self' else 'qr' end,v_late)
  on conflict(organization_id,user_id,attendance_date) do nothing returning * into v_record;
 end;
 if v_record.id is null then raise exception 'attendance already started for today'; end if;
 return v_record;
end $$;
create or replace function public.attendance_check_out(p_organization_id uuid,p_latitude double precision default null,p_longitude double precision default null) returns public.attendance_records
language plpgsql security definer set search_path=public,auth as $$ declare v_uid uuid:=auth.uid(); v_day date; v_row public.attendance_records; v_tz text; v_shift public.shifts; v_assignment public.employee_shifts; v_early integer:=0; v_ot integer:=0; begin
 if v_uid is null or not public.is_org_member(p_organization_id) then raise exception 'organization membership required'; end if;
 select timezone into v_tz from public.organizations where id=p_organization_id; v_day:=(now() at time zone coalesce(v_tz,'UTC'))::date;
 select * into v_row from public.attendance_records where organization_id=p_organization_id and user_id=v_uid and attendance_date=v_day for update;
 if not found or v_row.check_in_at is null then raise exception 'check in before checking out'; end if;
 if v_row.check_out_at is not null then raise exception 'already checked out'; end if;
 if exists(select 1 from public.attendance_breaks where attendance_id=v_row.id and ended_at is null) then raise exception 'end the active break before checking out'; end if;
 select es.* into v_assignment from public.employee_shifts es where es.organization_id=p_organization_id and es.user_id=v_uid and es.work_date=v_day limit 1;
 if found then
  select * into v_shift from public.shifts where id=v_assignment.shift_id;
  v_early:=greatest(0,floor(extract(epoch from (v_shift.end_time-(now() at time zone v_tz)::time))/60)::integer);
  v_ot:=greatest(0,floor(extract(epoch from ((now() at time zone v_tz)::time-v_shift.end_time))/60)::integer);
 end if;
 update public.attendance_records set check_out_at=now(),check_out_latitude=p_latitude,check_out_longitude=p_longitude,early_exit_minutes=v_early,overtime_minutes=v_ot,status=case when v_early>0 then 'early_exit'::public.attendance_status else 'present'::public.attendance_status end where id=v_row.id returning * into v_row; return v_row;
end $$;
create or replace function public.attendance_break(p_organization_id uuid,p_action text) returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare v_uid uuid:=auth.uid(); v_day date; v_attendance public.attendance_records; v_break public.attendance_breaks; v_tz text; begin
 if v_uid is null or not public.is_org_member(p_organization_id) then raise exception 'organization membership required'; end if;
 select timezone into v_tz from public.organizations where id=p_organization_id; v_day:=(now() at time zone coalesce(v_tz,'UTC'))::date;
 select * into v_attendance from public.attendance_records where organization_id=p_organization_id and user_id=v_uid and attendance_date=v_day and check_out_at is null for update;
 if not found then raise exception 'active attendance is required'; end if;
 if p_action='start' then
  if exists(select 1 from public.attendance_breaks where attendance_id=v_attendance.id and ended_at is null) then raise exception 'break already active'; end if;
  insert into public.attendance_breaks(organization_id,attendance_id,user_id) values(p_organization_id,v_attendance.id,v_uid) returning * into v_break;
 else
  update public.attendance_breaks set ended_at=now() where attendance_id=v_attendance.id and ended_at is null returning * into v_break;
  if not found then raise exception 'no active break'; end if;
 end if;
 return to_jsonb(v_break);
end $$;

create or replace function public.decide_leave_request(p_organization_id uuid,p_leave_id uuid,p_decision text,p_reason text default '') returns public.leave_requests
language plpgsql security definer set search_path=public,auth as $$ declare v_role public.member_role; v_req public.leave_requests; begin
 select role into v_role from public.organization_members where organization_id=p_organization_id and user_id=auth.uid() and active;
 if v_role not in ('manager','hr','admin','super_admin') then raise exception 'leave approval permission required'; end if;
 select * into v_req from public.leave_requests where id=p_leave_id and organization_id=p_organization_id for update;
 if not found or v_req.status not in ('pending','manager_approved') then raise exception 'leave request is not awaiting this decision'; end if;
 if v_role='manager' and v_req.status='pending' then update public.leave_requests set status=case when p_decision='approved' then 'manager_approved'::public.leave_status else 'rejected'::public.leave_status end,manager_id=auth.uid(),manager_decision_at=now(),manager_reason=p_reason where id=p_leave_id returning * into v_req;
 elsif v_role in ('hr','admin','super_admin') and v_req.status='manager_approved' then update public.leave_requests set status=case when p_decision='approved' then 'approved'::public.leave_status else 'rejected'::public.leave_status end,hr_id=auth.uid(),hr_decision_at=now(),hr_reason=p_reason where id=p_leave_id returning * into v_req;
 else raise exception 'HR approval is required after manager review'; end if;
 return v_req;
end $$;
grant execute on function public.attendance_check_in(uuid,uuid,double precision,double precision,text,text) to authenticated;
grant execute on function public.attendance_check_out(uuid,double precision,double precision) to authenticated;
grant execute on function public.attendance_break(uuid,text) to authenticated;
grant execute on function public.decide_leave_request(uuid,uuid,text,text) to authenticated;

create or replace function public.create_qr_challenge(p_organization_id uuid,p_location_id uuid default null) returns table(token text,expires_at timestamptz)
language plpgsql security definer set search_path=public,auth,extensions as $$ declare v_token text; v_exp timestamptz:=now()+interval '60 seconds'; begin
 if not public.has_org_role(p_organization_id,array['admin','hr']::public.member_role[]) then raise exception 'administrator permission required'; end if;
 if p_location_id is not null and not exists(select 1 from public.office_locations where id=p_location_id and organization_id=p_organization_id and active) then raise exception 'office location unavailable'; end if;
 v_token:=encode(gen_random_bytes(32),'hex');
 insert into public.qr_challenges(organization_id,location_id,token_hash,valid_from,expires_at) values(p_organization_id,p_location_id,encode(digest(v_token,'sha256'),'hex'),now(),v_exp);
 return query select v_token,v_exp;
end $$;
revoke all on function public.create_qr_challenge(uuid,uuid) from public;
grant execute on function public.create_qr_challenge(uuid,uuid) to authenticated;

create or replace function public.correct_attendance(p_organization_id uuid,p_attendance_id uuid,p_check_in timestamptz,p_check_out timestamptz,p_reason text) returns public.attendance_records
language plpgsql security definer set search_path=public,auth as $$ declare v_row public.attendance_records; v_old jsonb; begin
 if not public.has_org_role(p_organization_id,array['admin','hr']::public.member_role[]) then raise exception 'attendance correction permission required'; end if;
 if char_length(trim(p_reason))<5 then raise exception 'a correction reason of at least five characters is required'; end if;
 if p_check_out is not null and p_check_in is not null and p_check_out<=p_check_in then raise exception 'check-out must be after check-in'; end if;
 select * into v_row from public.attendance_records where id=p_attendance_id and organization_id=p_organization_id for update;
 if not found then raise exception 'attendance record not found'; end if;
 v_old:=jsonb_build_object('check_in_at',v_row.check_in_at,'check_out_at',v_row.check_out_at,'status',v_row.status);
 update public.attendance_records set check_in_at=p_check_in,check_out_at=p_check_out,status='corrected' where id=p_attendance_id returning * into v_row;
 insert into public.attendance_corrections(organization_id,attendance_id,changed_by,reason,old_values,new_values) values(p_organization_id,p_attendance_id,auth.uid(),trim(p_reason),v_old,jsonb_build_object('check_in_at',v_row.check_in_at,'check_out_at',v_row.check_out_at,'status',v_row.status));
 return v_row;
end $$;
revoke all on function public.correct_attendance(uuid,uuid,timestamptz,timestamptz,text) from public;
grant execute on function public.correct_attendance(uuid,uuid,timestamptz,timestamptz,text) to authenticated;

create or replace function public.log_workforce_event(p_organization_id uuid,p_event_type text,p_ip_hash text default null,p_user_agent text default null,p_metadata jsonb default '{}'::jsonb) returns uuid
language plpgsql security definer set search_path=public,auth as $$ declare v_event uuid; begin
 if auth.uid() is null then raise exception 'authentication required'; end if;
 if p_event_type not in ('login','logout','session_refresh','module_view') then raise exception 'unsupported workforce event'; end if;
 if p_organization_id is not null and not public.is_org_member(p_organization_id) then raise exception 'organization membership required'; end if;
 if octet_length(coalesce(p_metadata,'{}'::jsonb)::text)>2048 then raise exception 'event metadata is too large'; end if;
 insert into public.workforce_events(organization_id,user_id,event_type,ip_hash,user_agent,metadata)
 values(p_organization_id,auth.uid(),p_event_type,left(p_ip_hash,128),left(p_user_agent,512),coalesce(p_metadata,'{}'::jsonb)) returning id into v_event;
 if p_organization_id is not null then insert into public.audit_logs(organization_id,actor_id,action,entity_type,entity_id,ip_hash,new_value) values(p_organization_id,auth.uid(),'session.'||p_event_type,'workforce_event',v_event::text,left(p_ip_hash,128),coalesce(p_metadata,'{}'::jsonb)); end if;
 return v_event;
end $$;
revoke all on function public.log_workforce_event(uuid,text,text,text,jsonb) from public;
grant execute on function public.log_workforce_event(uuid,text,text,text,jsonb) to authenticated;

create or replace function public.change_member_role(p_organization_id uuid,p_user_id uuid,p_role public.member_role) returns public.organization_members
language plpgsql security definer set search_path=public,auth as $$ declare v_target public.organization_members; v_admins integer; begin
 if not public.has_org_role(p_organization_id,array['admin']::public.member_role[]) then raise exception 'administrator permission required'; end if;
 if p_role='super_admin' then raise exception 'super admin is a platform-level role'; end if;
 select * into v_target from public.organization_members where organization_id=p_organization_id and user_id=p_user_id and active for update;
 if not found then raise exception 'active member not found'; end if;
 if v_target.role in ('admin','super_admin') and p_role not in ('admin','super_admin') then
  select count(*) into v_admins from public.organization_members where organization_id=p_organization_id and active and role in ('admin','super_admin');
  if v_admins<=1 then raise exception 'the organization must retain at least one active administrator'; end if;
 end if;
 update public.organization_members set role=p_role where id=v_target.id returning * into v_target; return v_target;
end $$;
revoke all on function public.change_member_role(uuid,uuid,public.member_role) from public;
grant execute on function public.change_member_role(uuid,uuid,public.member_role) to authenticated;

create or replace function public.set_attendance_policy(p_organization_id uuid,p_allowed_types text[]) returns public.organizations
language plpgsql security definer set search_path=public,auth as $$ declare v_org public.organizations; begin
 if not public.has_org_role(p_organization_id,array['admin','hr']::public.member_role[]) then raise exception 'organization administrator permission required'; end if;
 if coalesce(array_length(p_allowed_types,1),0)=0 or exists(select 1 from unnest(p_allowed_types) mode where mode not in ('office','hybrid','remote','field')) then raise exception 'choose one or more supported attendance types'; end if;
 update public.organizations set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{allowed_attendance_types}',to_jsonb(p_allowed_types),true) where id=p_organization_id returning * into v_org;
 return v_org;
end $$;
revoke all on function public.set_attendance_policy(uuid,text[]) from public;
grant execute on function public.set_attendance_policy(uuid,text[]) to authenticated;

alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.office_locations enable row level security;
alter table public.shifts enable row level security;
alter table public.employee_shifts enable row level security;
alter table public.attendance_records enable row level security;
alter table public.attendance_breaks enable row level security;
alter table public.attendance_corrections enable row level security;
alter table public.leave_requests enable row level security;
alter table public.trusted_devices enable row level security;
alter table public.workforce_events enable row level security;
alter table public.audit_logs enable row level security;
alter table public.qr_challenges enable row level security;
alter table public.notification_outbox enable row level security;

create policy "profiles read self or coworker" on public.profiles for select to authenticated using (id=auth.uid() or exists(select 1 from public.organization_members mine join public.organization_members theirs using(organization_id) where mine.user_id=auth.uid() and mine.active and theirs.user_id=id and theirs.active));
create policy "profiles self update" on public.profiles for update to authenticated using(id=auth.uid()) with check(id=auth.uid());
create policy "organizations visible to members" on public.organizations for select to authenticated using(public.is_org_member(id));
create policy "organization admins update" on public.organizations for update to authenticated using(public.has_org_role(id,array['admin','hr']::public.member_role[])) with check(public.has_org_role(id,array['admin','hr']::public.member_role[]));
create policy "members visible in organization" on public.organization_members for select to authenticated using(public.is_org_member(organization_id));
create policy "admins manage members" on public.organization_members for all to authenticated using(public.has_org_role(organization_id,array['admin']::public.member_role[])) with check(public.has_org_role(organization_id,array['admin']::public.member_role[]));
create policy "locations visible to members" on public.office_locations for select to authenticated using(public.is_org_member(organization_id));
create policy "admins manage locations" on public.office_locations for all to authenticated using(public.has_org_role(organization_id,array['admin','hr']::public.member_role[])) with check(public.has_org_role(organization_id,array['admin','hr']::public.member_role[]));
create policy "shifts visible to members" on public.shifts for select to authenticated using(public.is_org_member(organization_id));
create policy "admins manage shifts" on public.shifts for all to authenticated using(public.has_org_role(organization_id,array['admin','hr']::public.member_role[])) with check(public.has_org_role(organization_id,array['admin','hr']::public.member_role[]));
create policy "employee shifts visible to members" on public.employee_shifts for select to authenticated using(public.is_org_member(organization_id));
create policy "admins assign shifts" on public.employee_shifts for all to authenticated using(public.has_org_role(organization_id,array['admin','hr','manager']::public.member_role[])) with check(public.has_org_role(organization_id,array['admin','hr','manager']::public.member_role[]));
create policy "attendance own or privileged read" on public.attendance_records for select to authenticated using(user_id=auth.uid() or public.has_org_role(organization_id,array['admin','hr','manager','auditor']::public.member_role[]));
create policy "breaks own or privileged read" on public.attendance_breaks for select to authenticated using(user_id=auth.uid() or public.has_org_role(organization_id,array['admin','hr','manager','auditor']::public.member_role[]));
create policy "corrections privileged read" on public.attendance_corrections for select to authenticated using(public.has_org_role(organization_id,array['admin','hr','auditor']::public.member_role[]));
create policy "leave own or privileged read" on public.leave_requests for select to authenticated using(user_id=auth.uid() or public.has_org_role(organization_id,array['admin','hr','manager','auditor']::public.member_role[]));
create policy "employee creates own leave" on public.leave_requests for insert to authenticated with check(user_id=auth.uid() and public.is_org_member(organization_id));
create policy "devices self or admin read" on public.trusted_devices for select to authenticated using(user_id=auth.uid() or (organization_id is not null and public.has_org_role(organization_id,array['admin','hr']::public.member_role[])));
create policy "workforce events privileged read" on public.workforce_events for select to authenticated using(user_id=auth.uid() or (organization_id is not null and public.has_org_role(organization_id,array['admin','hr','auditor']::public.member_role[])));
create policy "audit visible to auditor roles" on public.audit_logs for select to authenticated using(organization_id is not null and public.has_org_role(organization_id,array['admin','hr','auditor']::public.member_role[]));
create policy "QR challenges admin read" on public.qr_challenges for select to authenticated using(public.has_org_role(organization_id,array['admin','hr']::public.member_role[]));
create policy "outbox privileged read" on public.notification_outbox for select to authenticated using(public.has_org_role(organization_id,array['admin','hr']::public.member_role[]));

revoke all on all tables in schema public from anon,authenticated;
grant select,update on public.profiles to authenticated;
grant select,update on public.organizations to authenticated;
grant select,insert,update,delete on public.organization_members,public.office_locations,public.shifts,public.employee_shifts to authenticated;
grant select on public.attendance_records,public.attendance_breaks,public.attendance_corrections,public.audit_logs,public.trusted_devices,public.workforce_events,public.qr_challenges,public.notification_outbox to authenticated;
grant select,insert on public.leave_requests to authenticated;
