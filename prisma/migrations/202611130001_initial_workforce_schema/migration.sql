-- AttendFlow initial schema. Apply through Prisma Migrate to the Supabase project.
-- This migration is additive and intentionally contains no destructive resets.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE TYPE "EmployeeRole" AS ENUM ('EMPLOYEE', 'ADMINISTRATOR');
CREATE TYPE "EmployeeStatus" AS ENUM ('INVITED', 'ACTIVE', 'DEACTIVATED');
CREATE TYPE "AttendanceStatus" AS ENUM ('IN_PROGRESS', 'PRESENT', 'ABSENT', 'LATE', 'LEAVE', 'HALF_DAY', 'REMOTE_WORK');
CREATE TYPE "AttendanceType" AS ENUM ('OFFICE', 'REMOTE');
CREATE TYPE "AttendanceEventType" AS ENUM ('LOGIN', 'LOGOUT', 'CHECK_IN', 'CHECK_OUT', 'CORRECTION', 'PASSWORD_CHANGE', 'LEAVE_REQUEST', 'EMPLOYEE_CREATED', 'EMPLOYEE_UPDATED', 'LOCATION_UPDATED', 'SESSION_REFRESH');
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'PUSH');
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED');

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(160) NOT NULL,
  slug varchar(80) NOT NULL UNIQUE,
  timezone varchar(64) NOT NULL DEFAULT 'UTC',
  settings jsonb NOT NULL DEFAULT '{"attendanceMode":"OFFICE","shiftStart":"09:00","lateGraceMinutes":5,"maxGpsAccuracyMeters":100}'::jsonb,
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  updated_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT organizations_name_nonempty CHECK (length(trim(name)) BETWEEN 2 AND 160)
);

CREATE TABLE departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name varchar(120) NOT NULL,
  description varchar(500),
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  updated_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT departments_name_nonempty CHECK (length(trim(name)) BETWEEN 2 AND 120),
  CONSTRAINT departments_org_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT departments_org_name_unique UNIQUE (organization_id, name)
);
CREATE INDEX departments_org_created_idx ON departments(organization_id, created_at DESC);

CREATE TABLE employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  supabase_user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE RESTRICT,
  employee_number varchar(40) NOT NULL,
  full_name varchar(160) NOT NULL,
  email varchar(320) NOT NULL,
  phone varchar(32),
  department_id uuid,
  designation varchar(120) NOT NULL,
  role "EmployeeRole" NOT NULL DEFAULT 'EMPLOYEE',
  status "EmployeeStatus" NOT NULL DEFAULT 'INVITED',
  deactivated_at timestamptz(6),
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  updated_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT employees_full_name_nonempty CHECK (length(trim(full_name)) BETWEEN 2 AND 160),
  CONSTRAINT employees_email_lowercase CHECK (email = lower(email)),
  CONSTRAINT employees_org_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT employees_org_number_unique UNIQUE (organization_id, employee_number),
  CONSTRAINT employees_org_email_unique UNIQUE (organization_id, email),
  CONSTRAINT employees_org_department_fk FOREIGN KEY (organization_id, department_id) REFERENCES departments(organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX employees_org_status_name_idx ON employees(organization_id, status, full_name);
CREATE INDEX employees_org_department_status_idx ON employees(organization_id, department_id, status);
CREATE INDEX employees_auth_org_idx ON employees(supabase_user_id, organization_id, status);

CREATE TABLE office_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name varchar(120) NOT NULL,
  latitude numeric(9,6) NOT NULL,
  longitude numeric(9,6) NOT NULL,
  radius_meters integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  updated_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT locations_latitude_range CHECK (latitude BETWEEN -90 AND 90),
  CONSTRAINT locations_longitude_range CHECK (longitude BETWEEN -180 AND 180),
  CONSTRAINT locations_radius_range CHECK (radius_meters BETWEEN 20 AND 10000),
  CONSTRAINT locations_org_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT locations_org_name_unique UNIQUE (organization_id, name)
);
CREATE INDEX locations_org_active_idx ON office_locations(organization_id, active);

CREATE TABLE attendance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL,
  work_date date NOT NULL,
  check_in_at timestamptz(6),
  check_out_at timestamptz(6),
  total_work_minutes integer,
  late_minutes integer NOT NULL DEFAULT 0,
  status "AttendanceStatus" NOT NULL DEFAULT 'IN_PROGRESS',
  attendance_type "AttendanceType" NOT NULL DEFAULT 'OFFICE',
  check_in_location_id uuid,
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  updated_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT attendance_org_employee_fk FOREIGN KEY (organization_id, employee_id) REFERENCES employees(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT attendance_org_location_fk FOREIGN KEY (organization_id, check_in_location_id) REFERENCES office_locations(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT attendance_org_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT attendance_day_unique UNIQUE (organization_id, employee_id, work_date),
  CONSTRAINT attendance_time_order CHECK (check_out_at IS NULL OR (check_in_at IS NOT NULL AND check_out_at > check_in_at)),
  CONSTRAINT attendance_work_minutes_nonnegative CHECK (total_work_minutes IS NULL OR total_work_minutes >= 0),
  CONSTRAINT attendance_late_minutes_nonnegative CHECK (late_minutes >= 0)
);
CREATE INDEX attendance_org_date_status_idx ON attendance(organization_id, work_date, status);
CREATE INDEX attendance_org_employee_date_idx ON attendance(organization_id, employee_id, work_date DESC);
CREATE INDEX attendance_open_day_idx ON attendance(organization_id, employee_id, work_date) WHERE check_in_at IS NOT NULL AND check_out_at IS NULL;

CREATE TABLE attendance_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  attendance_id uuid,
  employee_id uuid NOT NULL,
  actor_employee_id uuid,
  location_id uuid,
  type "AttendanceEventType" NOT NULL,
  occurred_at timestamptz(6) NOT NULL DEFAULT now(),
  latitude numeric(9,6),
  longitude numeric(9,6),
  accuracy_meters numeric(8,2),
  distance_meters numeric(10,2),
  ip_hash varchar(128),
  browser varchar(160),
  device varchar(160),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id varchar(80),
  CONSTRAINT events_org_attendance_fk FOREIGN KEY (organization_id, attendance_id) REFERENCES attendance(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT events_org_employee_fk FOREIGN KEY (organization_id, employee_id) REFERENCES employees(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT events_org_actor_fk FOREIGN KEY (organization_id, actor_employee_id) REFERENCES employees(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT events_org_location_fk FOREIGN KEY (organization_id, location_id) REFERENCES office_locations(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT events_coordinates_pair CHECK ((latitude IS NULL AND longitude IS NULL) OR (latitude IS NOT NULL AND longitude IS NOT NULL)),
  CONSTRAINT events_accuracy_positive CHECK (accuracy_meters IS NULL OR accuracy_meters > 0),
  CONSTRAINT events_distance_nonnegative CHECK (distance_meters IS NULL OR distance_meters >= 0)
);
CREATE INDEX attendance_events_org_time_idx ON attendance_events(organization_id, occurred_at DESC);
CREATE INDEX attendance_events_org_employee_time_idx ON attendance_events(organization_id, employee_id, occurred_at DESC);
CREATE INDEX attendance_events_record_time_idx ON attendance_events(attendance_id, occurred_at);

CREATE TABLE user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL,
  session_key_hash varchar(128) NOT NULL,
  login_at timestamptz(6) NOT NULL DEFAULT now(),
  logout_at timestamptz(6),
  ip_hash varchar(128),
  browser varchar(160),
  device varchar(160),
  latitude numeric(9,6),
  longitude numeric(9,6),
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT sessions_org_employee_fk FOREIGN KEY (organization_id, employee_id) REFERENCES employees(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT sessions_org_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT sessions_employee_key_unique UNIQUE (employee_id, session_key_hash),
  CONSTRAINT sessions_time_order CHECK (logout_at IS NULL OR logout_at >= login_at),
  CONSTRAINT sessions_coordinates_pair CHECK ((latitude IS NULL AND longitude IS NULL) OR (latitude IS NOT NULL AND longitude IS NOT NULL))
);
CREATE INDEX sessions_org_login_idx ON user_sessions(organization_id, login_at DESC);
CREATE INDEX sessions_org_employee_login_idx ON user_sessions(organization_id, employee_id, login_at DESC);

CREATE TABLE audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid REFERENCES organizations(id) ON DELETE RESTRICT,
  actor_employee_id uuid,
  action varchar(80) NOT NULL,
  entity_type varchar(80) NOT NULL,
  entity_id varchar(80),
  previous_values jsonb,
  new_values jsonb,
  reason varchar(1000),
  ip_hash varchar(128),
  device varchar(160),
  location jsonb,
  request_id varchar(80),
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT audit_actor_org_fk FOREIGN KEY (organization_id, actor_employee_id) REFERENCES employees(organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX audit_org_time_idx ON audit_logs(organization_id, created_at DESC);
CREATE INDEX audit_org_actor_time_idx ON audit_logs(organization_id, actor_employee_id, created_at DESC);
CREATE INDEX audit_org_entity_idx ON audit_logs(organization_id, entity_type, entity_id);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL,
  channel "NotificationChannel" NOT NULL,
  event_type varchar(80) NOT NULL,
  title varchar(160) NOT NULL,
  body varchar(2000) NOT NULL,
  status "NotificationStatus" NOT NULL DEFAULT 'PENDING',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz(6) NOT NULL DEFAULT now(),
  sent_at timestamptz(6),
  last_error varchar(1000),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  updated_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT notifications_org_employee_fk FOREIGN KEY (organization_id, employee_id) REFERENCES employees(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT notifications_attempts_nonnegative CHECK (attempts >= 0)
);
CREATE INDEX notifications_delivery_idx ON notifications(status, next_attempt_at);
CREATE INDEX notifications_org_employee_created_idx ON notifications(organization_id, employee_id, created_at DESC);

CREATE TABLE organization_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  email varchar(320) NOT NULL,
  employee_number varchar(40) NOT NULL,
  department_id uuid,
  designation varchar(120) NOT NULL,
  code_hash varchar(128) NOT NULL UNIQUE,
  created_by_employee_id uuid NOT NULL,
  expires_at timestamptz(6) NOT NULL,
  redeemed_at timestamptz(6),
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT invites_email_lowercase CHECK (email = lower(email)),
  CONSTRAINT invites_org_department_fk FOREIGN KEY (organization_id, department_id) REFERENCES departments(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT invites_org_creator_fk FOREIGN KEY (organization_id, created_by_employee_id) REFERENCES employees(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT invites_org_id_id_unique UNIQUE (organization_id, id),
  CONSTRAINT invites_org_email_redeemed_unique UNIQUE (organization_id, email, redeemed_at),
  CONSTRAINT invites_expiry_after_creation CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX invites_active_email_unique ON organization_invites(organization_id, email) WHERE redeemed_at IS NULL;
CREATE INDEX invites_org_expiry_idx ON organization_invites(organization_id, expires_at);

CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;
CREATE TRIGGER organizations_touch BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER departments_touch BEFORE UPDATE ON departments FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER employees_touch BEFORE UPDATE ON employees FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER locations_touch BEFORE UPDATE ON office_locations FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER attendance_touch BEFORE UPDATE ON attendance FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER notifications_touch BEFORE UPDATE ON notifications FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE OR REPLACE FUNCTION public.validate_organization_timezone() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name=NEW.timezone) THEN RAISE EXCEPTION 'Invalid organization timezone'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER organizations_timezone_valid BEFORE INSERT OR UPDATE OF timezone ON organizations FOR EACH ROW EXECUTE FUNCTION public.validate_organization_timezone();

-- RLS identity helpers are SECURITY DEFINER to avoid recursive policies on employees.
CREATE OR REPLACE FUNCTION public.current_employee_id(p_organization_id uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth, pg_temp AS $$
  SELECT e.id FROM public.employees e
  WHERE e.organization_id = p_organization_id AND e.supabase_user_id = auth.uid() AND e.status = 'ACTIVE'
  LIMIT 1
$$;
CREATE OR REPLACE FUNCTION public.current_employee_role(p_organization_id uuid) RETURNS "EmployeeRole"
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth, pg_temp AS $$
  SELECT e.role FROM public.employees e
  WHERE e.organization_id = p_organization_id AND e.supabase_user_id = auth.uid() AND e.status = 'ACTIVE'
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.current_employee_id(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.current_employee_role(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_employee_id(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_employee_role(uuid) TO authenticated;

-- Generic immutable audit capture. Trigger execution is independent of API-side audit calls.
CREATE OR REPLACE FUNCTION public.capture_audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, pg_temp AS $$
DECLARE
  v_old jsonb;
  v_new jsonb;
  v_row jsonb;
  v_org uuid;
  v_entity_id text;
  v_employee uuid;
  v_action text;
BEGIN
  IF TG_OP = 'INSERT' THEN v_row := to_jsonb(NEW); v_new := v_row;
  ELSIF TG_OP = 'UPDATE' THEN v_old := to_jsonb(OLD); v_row := to_jsonb(NEW); v_new := v_row;
  ELSE v_row := to_jsonb(OLD); v_old := v_row; END IF;
  IF TG_TABLE_NAME IN ('attendance_events','user_sessions') THEN
    v_old := CASE WHEN v_old IS NULL THEN NULL ELSE v_old - 'session_key_hash' - 'latitude' - 'longitude' - 'ip_hash' END;
    v_new := CASE WHEN v_new IS NULL THEN NULL ELSE v_new - 'session_key_hash' - 'latitude' - 'longitude' - 'ip_hash' END;
  END IF;
  IF TG_TABLE_NAME='organization_invites' THEN
    v_old := CASE WHEN v_old IS NULL THEN NULL ELSE v_old - 'code_hash' END;
    v_new := CASE WHEN v_new IS NULL THEN NULL ELSE v_new - 'code_hash' END;
  END IF;
  v_org := CASE WHEN TG_TABLE_NAME='organizations' THEN nullif(v_row->>'id','')::uuid ELSE nullif(v_row->>'organization_id','')::uuid END;
  v_entity_id := coalesce(v_row->>'id','');
  v_employee := CASE WHEN auth.uid() IS NULL THEN NULL ELSE public.current_employee_id(v_org) END;
  v_action := lower(TG_OP) || '.' || TG_TABLE_NAME;
  INSERT INTO public.audit_logs(organization_id, actor_employee_id, action, entity_type, entity_id, previous_values, new_values)
  VALUES (v_org, v_employee, v_action, TG_TABLE_NAME, v_entity_id, v_old, v_new);
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
CREATE TRIGGER organizations_audit AFTER UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION public.capture_audit_row();
CREATE TRIGGER departments_audit AFTER INSERT OR UPDATE ON departments FOR EACH ROW EXECUTE FUNCTION public.capture_audit_row();
CREATE TRIGGER employees_audit AFTER INSERT OR UPDATE ON employees FOR EACH ROW EXECUTE FUNCTION public.capture_audit_row();
CREATE TRIGGER locations_audit AFTER INSERT OR UPDATE ON office_locations FOR EACH ROW EXECUTE FUNCTION public.capture_audit_row();
CREATE TRIGGER attendance_audit AFTER INSERT OR UPDATE ON attendance FOR EACH ROW EXECUTE FUNCTION public.capture_audit_row();
CREATE TRIGGER attendance_events_audit AFTER INSERT ON attendance_events FOR EACH ROW EXECUTE FUNCTION public.capture_audit_row();
CREATE TRIGGER user_sessions_audit AFTER INSERT OR UPDATE ON user_sessions FOR EACH ROW EXECUTE FUNCTION public.capture_audit_row();

CREATE OR REPLACE FUNCTION public.reject_append_only_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000'; END;
$$;
CREATE TRIGGER attendance_events_immutable BEFORE UPDATE OR DELETE ON attendance_events FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();

CREATE OR REPLACE FUNCTION public.distance_meters(lat1 double precision, lon1 double precision, lat2 double precision, lon2 double precision) RETURNS double precision
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT 6371000 * 2 * asin(sqrt(power(sin(radians(lat2-lat1)/2),2) + cos(radians(lat1))*cos(radians(lat2))*power(sin(radians(lon2-lon1)/2),2)))
$$;

CREATE OR REPLACE FUNCTION public.attendance_check_in(
  p_organization_id uuid, p_latitude numeric, p_longitude numeric, p_accuracy_meters numeric,
  p_ip_hash text DEFAULT NULL, p_browser text DEFAULT NULL, p_device text DEFAULT NULL, p_request_id text DEFAULT NULL,
  p_attendance_type "AttendanceType" DEFAULT 'OFFICE'
) RETURNS public.attendance
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, extensions, pg_temp AS $$
DECLARE
  v_employee public.employees;
  v_org public.organizations;
  v_location public.office_locations;
  v_attendance public.attendance;
  v_date date;
  v_local timestamp;
  v_shift_start time;
  v_grace integer;
  v_late integer;
BEGIN
  SELECT * INTO v_employee FROM public.employees
    WHERE organization_id = p_organization_id AND supabase_user_id = auth.uid() AND status = 'ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'active employee membership required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_org FROM public.organizations WHERE id = p_organization_id;
  IF p_attendance_type='REMOTE' AND v_org.settings->>'attendanceMode' NOT IN ('HYBRID','REMOTE') THEN RAISE EXCEPTION 'Remote attendance is not enabled by organization policy'; END IF;
  IF p_attendance_type = 'OFFICE' THEN
    IF p_latitude IS NULL OR p_longitude IS NULL OR p_accuracy_meters IS NULL THEN RAISE EXCEPTION 'GPS coordinates and accuracy are required'; END IF;
    IF p_accuracy_meters <= 0 OR p_accuracy_meters > coalesce((v_org.settings->>'maxGpsAccuracyMeters')::numeric,100) THEN RAISE EXCEPTION 'GPS accuracy is not sufficient'; END IF;
    SELECT l.* INTO v_location FROM public.office_locations l
      WHERE l.organization_id = p_organization_id AND l.active
        AND public.distance_meters(l.latitude::float8,l.longitude::float8,p_latitude::float8,p_longitude::float8) <= l.radius_meters
      ORDER BY public.distance_meters(l.latitude::float8,l.longitude::float8,p_latitude::float8,p_longitude::float8) ASC LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'Outside Authorized Location'; END IF;
  END IF;
  v_local := now() AT TIME ZONE v_org.timezone;
  v_date := v_local::date;
  v_shift_start := coalesce((v_org.settings->>'shiftStart')::time, time '09:00');
  v_grace := greatest(0, least(240, coalesce((v_org.settings->>'lateGraceMinutes')::integer,5)));
  v_late := greatest(0, floor(extract(epoch FROM (v_local::time - v_shift_start))/60)::integer - v_grace);
  INSERT INTO public.attendance(organization_id,employee_id,work_date,check_in_at,status,attendance_type,check_in_location_id,late_minutes)
  VALUES (p_organization_id,v_employee.id,v_date,now(),CASE WHEN p_attendance_type='REMOTE' THEN 'REMOTE_WORK'::"AttendanceStatus" WHEN v_late>0 THEN 'LATE'::"AttendanceStatus" ELSE 'IN_PROGRESS'::"AttendanceStatus" END,p_attendance_type,v_location.id,v_late)
  ON CONFLICT (organization_id,employee_id,work_date) DO NOTHING RETURNING * INTO v_attendance;
  IF v_attendance.id IS NULL THEN RAISE EXCEPTION 'Attendance has already started for this work date' USING ERRCODE = '23505'; END IF;
  INSERT INTO public.attendance_events(organization_id,attendance_id,employee_id,actor_employee_id,location_id,type,latitude,longitude,accuracy_meters,distance_meters,ip_hash,browser,device,request_id)
  VALUES (p_organization_id,v_attendance.id,v_employee.id,v_employee.id,v_location.id,'CHECK_IN',p_latitude,p_longitude,p_accuracy_meters,
    CASE WHEN v_location.id IS NULL THEN NULL ELSE public.distance_meters(v_location.latitude::float8,v_location.longitude::float8,p_latitude::float8,p_longitude::float8) END,
    left(p_ip_hash,128),left(p_browser,160),left(p_device,160),left(p_request_id,80));
  IF v_late > 0 THEN
    INSERT INTO public.notifications(organization_id,employee_id,channel,event_type,title,body)
    VALUES (p_organization_id,v_employee.id,'EMAIL','LATE_CHECK_IN','Late check-in recorded','Your check-in was after the configured grace period.');
  END IF;
  RETURN v_attendance;
END;
$$;

CREATE OR REPLACE FUNCTION public.attendance_check_out(
  p_organization_id uuid, p_latitude numeric DEFAULT NULL, p_longitude numeric DEFAULT NULL,
  p_ip_hash text DEFAULT NULL, p_browser text DEFAULT NULL, p_device text DEFAULT NULL, p_request_id text DEFAULT NULL
) RETURNS public.attendance
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, pg_temp AS $$
DECLARE
  v_employee public.employees;
  v_org public.organizations;
  v_attendance public.attendance;
  v_date date;
BEGIN
  SELECT * INTO v_employee FROM public.employees
    WHERE organization_id=p_organization_id AND supabase_user_id=auth.uid() AND status='ACTIVE';
  IF NOT FOUND THEN RAISE EXCEPTION 'active employee membership required' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_org FROM public.organizations WHERE id=p_organization_id;
  v_date := (now() AT TIME ZONE v_org.timezone)::date;
  SELECT * INTO v_attendance FROM public.attendance
    WHERE organization_id=p_organization_id AND employee_id=v_employee.id AND work_date=v_date FOR UPDATE;
  IF NOT FOUND OR v_attendance.check_in_at IS NULL THEN RAISE EXCEPTION 'Check in before checking out'; END IF;
  IF v_attendance.check_out_at IS NOT NULL THEN RAISE EXCEPTION 'Attendance has already been checked out' USING ERRCODE='23505'; END IF;
  UPDATE public.attendance SET check_out_at=now(), total_work_minutes=floor(extract(epoch FROM (now()-v_attendance.check_in_at))/60)::integer,
    status=CASE WHEN v_attendance.attendance_type='REMOTE' THEN 'REMOTE_WORK'::"AttendanceStatus" WHEN v_attendance.status='LATE' THEN 'LATE'::"AttendanceStatus" ELSE 'PRESENT'::"AttendanceStatus" END
    WHERE id=v_attendance.id RETURNING * INTO v_attendance;
  INSERT INTO public.attendance_events(organization_id,attendance_id,employee_id,actor_employee_id,type,latitude,longitude,ip_hash,browser,device,request_id)
  VALUES (p_organization_id,v_attendance.id,v_employee.id,v_employee.id,'CHECK_OUT',p_latitude,p_longitude,left(p_ip_hash,128),left(p_browser,160),left(p_device,160),left(p_request_id,80));
  RETURN v_attendance;
END;
$$;

CREATE OR REPLACE FUNCTION public.start_user_session(
  p_organization_id uuid, p_session_key_hash text, p_ip_hash text DEFAULT NULL,
  p_browser text DEFAULT NULL, p_device text DEFAULT NULL, p_latitude numeric DEFAULT NULL, p_longitude numeric DEFAULT NULL
) RETURNS public.user_sessions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, pg_temp AS $$
DECLARE v_employee public.employees; v_session public.user_sessions; v_created boolean := false;
BEGIN
  SELECT * INTO v_employee FROM public.employees WHERE organization_id=p_organization_id AND supabase_user_id=auth.uid() AND status='ACTIVE';
  IF NOT FOUND THEN RAISE EXCEPTION 'active employee membership required' USING ERRCODE='42501'; END IF;
  IF length(p_session_key_hash)<32 OR length(p_session_key_hash)>128 THEN RAISE EXCEPTION 'invalid session correlation key'; END IF;
  INSERT INTO public.user_sessions(organization_id,employee_id,session_key_hash,ip_hash,browser,device,latitude,longitude)
  VALUES (p_organization_id,v_employee.id,p_session_key_hash,left(p_ip_hash,128),left(p_browser,160),left(p_device,160),p_latitude,p_longitude)
  ON CONFLICT (employee_id,session_key_hash) DO NOTHING RETURNING * INTO v_session;
  v_created := FOUND;
  IF v_session.id IS NULL THEN SELECT * INTO v_session FROM public.user_sessions WHERE employee_id=v_employee.id AND session_key_hash=p_session_key_hash; END IF;
  IF v_created THEN
    INSERT INTO public.attendance_events(organization_id,employee_id,actor_employee_id,type,latitude,longitude,ip_hash,browser,device)
    VALUES (p_organization_id,v_employee.id,v_employee.id,'LOGIN',p_latitude,p_longitude,left(p_ip_hash,128),left(p_browser,160),left(p_device,160));
  END IF;
  RETURN v_session;
END;
$$;

CREATE OR REPLACE FUNCTION public.end_user_session(p_organization_id uuid,p_session_key_hash text,p_ip_hash text DEFAULT NULL,p_browser text DEFAULT NULL,p_device text DEFAULT NULL) RETURNS public.user_sessions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, pg_temp AS $$
DECLARE v_employee public.employees; v_session public.user_sessions;
BEGIN
  SELECT * INTO v_employee FROM public.employees WHERE organization_id=p_organization_id AND supabase_user_id=auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'employee membership required' USING ERRCODE='42501'; END IF;
  UPDATE public.user_sessions SET logout_at=now() WHERE organization_id=p_organization_id AND employee_id=v_employee.id AND session_key_hash=p_session_key_hash AND logout_at IS NULL RETURNING * INTO v_session;
  IF NOT FOUND THEN RAISE EXCEPTION 'session is already closed or does not exist'; END IF;
  INSERT INTO public.attendance_events(organization_id,employee_id,actor_employee_id,type,ip_hash,browser,device)
  VALUES (p_organization_id,v_employee.id,v_employee.id,'LOGOUT',left(p_ip_hash,128),left(p_browser,160),left(p_device,160));
  RETURN v_session;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_correct_attendance(
  p_organization_id uuid,p_attendance_id uuid,p_check_in_at timestamptz,p_check_out_at timestamptz,
  p_status "AttendanceStatus",p_reason text,p_ip_hash text DEFAULT NULL,p_request_id text DEFAULT NULL
) RETURNS public.attendance
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, pg_temp AS $$
DECLARE v_actor uuid; v_record public.attendance; v_old jsonb;
BEGIN
  v_actor:=public.current_employee_id(p_organization_id);
  IF v_actor IS NULL OR public.current_employee_role(p_organization_id)<>'ADMINISTRATOR' THEN RAISE EXCEPTION 'administrator permission required' USING ERRCODE='42501'; END IF;
  IF length(trim(coalesce(p_reason,'')))<5 THEN RAISE EXCEPTION 'a correction reason is required'; END IF;
  IF p_status='IN_PROGRESS' THEN RAISE EXCEPTION 'an administrator cannot set an open attendance state'; END IF;
  IF p_check_out_at IS NOT NULL AND (p_check_in_at IS NULL OR p_check_out_at<=p_check_in_at) THEN RAISE EXCEPTION 'check-out must follow check-in'; END IF;
  SELECT * INTO v_record FROM public.attendance WHERE organization_id=p_organization_id AND id=p_attendance_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'attendance record not found'; END IF;
  v_old:=jsonb_build_object('check_in_at',v_record.check_in_at,'check_out_at',v_record.check_out_at,'status',v_record.status,'total_work_minutes',v_record.total_work_minutes);
  UPDATE public.attendance SET check_in_at=p_check_in_at,check_out_at=p_check_out_at,status=p_status,total_work_minutes=CASE WHEN p_check_in_at IS NOT NULL AND p_check_out_at IS NOT NULL THEN floor(extract(epoch FROM (p_check_out_at-p_check_in_at))/60)::integer ELSE NULL END WHERE id=p_attendance_id RETURNING * INTO v_record;
  INSERT INTO public.attendance_events(organization_id,attendance_id,employee_id,actor_employee_id,type,ip_hash,metadata,request_id)
  VALUES(p_organization_id,v_record.id,v_record.employee_id,v_actor,'CORRECTION',left(p_ip_hash,128),jsonb_build_object('reason',trim(p_reason),'previous',v_old,'new',jsonb_build_object('check_in_at',v_record.check_in_at,'check_out_at',v_record.check_out_at,'status',v_record.status)),left(p_request_id,80));
  RETURN v_record;
END;
$$;

REVOKE ALL ON FUNCTION public.attendance_check_in(uuid,numeric,numeric,numeric,text,text,text,text,"AttendanceType") FROM PUBLIC;
REVOKE ALL ON FUNCTION public.attendance_check_out(uuid,numeric,numeric,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.start_user_session(uuid,text,text,text,text,numeric,numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.end_user_session(uuid,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_correct_attendance(uuid,uuid,timestamptz,timestamptz,"AttendanceStatus",text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.attendance_check_in(uuid,numeric,numeric,numeric,text,text,text,text,"AttendanceType") TO authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_check_out(uuid,numeric,numeric,text,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.start_user_session(uuid,text,text,text,text,numeric,numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.end_user_session(uuid,text,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_correct_attendance(uuid,uuid,timestamptz,timestamptz,"AttendanceStatus",text,text,text) TO authenticated;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE office_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_invites ENABLE ROW LEVEL SECURITY;

CREATE POLICY organizations_member_read ON organizations FOR SELECT TO authenticated USING (public.current_employee_role(id) IS NOT NULL);
CREATE POLICY organizations_admin_update ON organizations FOR UPDATE TO authenticated USING (public.current_employee_role(id)='ADMINISTRATOR') WITH CHECK (public.current_employee_role(id)='ADMINISTRATOR');

CREATE POLICY departments_member_read ON departments FOR SELECT TO authenticated USING (public.current_employee_role(organization_id) IS NOT NULL);
CREATE POLICY departments_admin_write ON departments FOR INSERT TO authenticated WITH CHECK (public.current_employee_role(organization_id)='ADMINISTRATOR');
CREATE POLICY departments_admin_update ON departments FOR UPDATE TO authenticated USING (public.current_employee_role(organization_id)='ADMINISTRATOR') WITH CHECK (public.current_employee_role(organization_id)='ADMINISTRATOR');

CREATE POLICY employees_self_or_admin_read ON employees FOR SELECT TO authenticated USING (supabase_user_id=auth.uid() OR public.current_employee_role(organization_id)='ADMINISTRATOR');
CREATE POLICY employees_admin_insert ON employees FOR INSERT TO authenticated WITH CHECK (public.current_employee_role(organization_id)='ADMINISTRATOR');
CREATE POLICY employees_admin_update ON employees FOR UPDATE TO authenticated USING (public.current_employee_role(organization_id)='ADMINISTRATOR') WITH CHECK (public.current_employee_role(organization_id)='ADMINISTRATOR');

CREATE POLICY locations_member_read ON office_locations FOR SELECT TO authenticated USING (public.current_employee_role(organization_id) IS NOT NULL);
CREATE POLICY locations_admin_insert ON office_locations FOR INSERT TO authenticated WITH CHECK (public.current_employee_role(organization_id)='ADMINISTRATOR');
CREATE POLICY locations_admin_update ON office_locations FOR UPDATE TO authenticated USING (public.current_employee_role(organization_id)='ADMINISTRATOR') WITH CHECK (public.current_employee_role(organization_id)='ADMINISTRATOR');

CREATE POLICY attendance_self_or_admin_read ON attendance FOR SELECT TO authenticated USING (employee_id=public.current_employee_id(organization_id) OR public.current_employee_role(organization_id)='ADMINISTRATOR');
CREATE POLICY events_self_or_admin_read ON attendance_events FOR SELECT TO authenticated USING (employee_id=public.current_employee_id(organization_id) OR public.current_employee_role(organization_id)='ADMINISTRATOR');
CREATE POLICY sessions_self_or_admin_read ON user_sessions FOR SELECT TO authenticated USING (employee_id=public.current_employee_id(organization_id) OR public.current_employee_role(organization_id)='ADMINISTRATOR');
CREATE POLICY audit_admin_read ON audit_logs FOR SELECT TO authenticated USING (organization_id IS NOT NULL AND public.current_employee_role(organization_id)='ADMINISTRATOR');
CREATE POLICY notifications_self_or_admin_read ON notifications FOR SELECT TO authenticated USING (employee_id=public.current_employee_id(organization_id) OR public.current_employee_role(organization_id)='ADMINISTRATOR');
CREATE POLICY invites_admin_read ON organization_invites FOR SELECT TO authenticated USING (public.current_employee_role(organization_id)='ADMINISTRATOR');
CREATE POLICY invites_admin_insert ON organization_invites FOR INSERT TO authenticated WITH CHECK (public.current_employee_role(organization_id)='ADMINISTRATOR');

REVOKE ALL ON organizations,departments,employees,office_locations,attendance,attendance_events,user_sessions,audit_logs,notifications,organization_invites FROM anon,authenticated;
GRANT SELECT,UPDATE ON organizations TO authenticated;
GRANT SELECT,INSERT,UPDATE ON departments TO authenticated;
GRANT SELECT,INSERT,UPDATE ON employees TO authenticated;
GRANT SELECT,INSERT,UPDATE ON office_locations TO authenticated;
GRANT SELECT ON attendance,attendance_events,user_sessions,audit_logs,notifications,organization_invites TO authenticated;
GRANT INSERT ON organization_invites TO authenticated;

COMMENT ON TABLE attendance_events IS 'Append-only workforce and attendance event history. GPS is retained only under organization policy.';
COMMENT ON TABLE audit_logs IS 'Append-only audit evidence; do not store raw access tokens or passwords.';
COMMENT ON COLUMN user_sessions.ip_hash IS 'HMAC hash of the source address; raw IP addresses are intentionally not stored.';
COMMENT ON COLUMN user_sessions.session_key_hash IS 'Hash of a client session correlation key; never an access or refresh token.';
