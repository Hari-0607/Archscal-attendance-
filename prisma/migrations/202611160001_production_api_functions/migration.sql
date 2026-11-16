-- Narrow SECURITY DEFINER entry points for the authenticated API role.
CREATE OR REPLACE FUNCTION public.attendance_check_in(
  p_organization_id uuid,p_latitude numeric,p_longitude numeric,p_accuracy_meters numeric,
  p_ip_hash text DEFAULT NULL,p_browser text DEFAULT NULL,p_device text DEFAULT NULL,p_request_id text DEFAULT NULL,
  p_attendance_type "AttendanceType" DEFAULT 'OFFICE'
) RETURNS public.attendance
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, extensions, pg_temp AS $$
DECLARE
  v_employee public.employees; v_org public.organizations; v_location public.office_locations; v_attendance public.attendance;
  v_date date; v_local timestamp; v_shift_start time; v_grace integer; v_late integer;
BEGIN
  SELECT * INTO v_employee FROM public.employees
    WHERE organization_id=p_organization_id AND supabase_user_id=auth.uid() AND status='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'active employee membership required' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_org FROM public.organizations WHERE id=p_organization_id;
  IF p_attendance_type='REMOTE' AND NOT v_employee.wfh_enabled THEN
    RAISE EXCEPTION 'remote attendance is not enabled for this employee' USING ERRCODE='42501';
  END IF;
  IF p_attendance_type='OFFICE' THEN
    IF p_latitude IS NULL OR p_longitude IS NULL OR p_accuracy_meters IS NULL OR p_accuracy_meters<=0
      OR p_accuracy_meters>coalesce((v_org.settings->>'maxGpsAccuracyMeters')::numeric,100) THEN
      RAISE EXCEPTION 'GPS coordinates and accuracy are required' USING ERRCODE='22023';
    END IF;
    SELECT l.* INTO v_location FROM public.office_locations l
      WHERE l.organization_id=p_organization_id AND l.active
        AND public.distance_meters(l.latitude::float8,l.longitude::float8,p_latitude::float8,p_longitude::float8)<=l.radius_meters
      ORDER BY public.distance_meters(l.latitude::float8,l.longitude::float8,p_latitude::float8,p_longitude::float8) LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'outside authorized location' USING ERRCODE='42501'; END IF;
  END IF;
  v_local:=now() AT TIME ZONE v_org.timezone; v_date:=v_local::date;
  v_shift_start:=coalesce((v_org.settings->>'shiftStart')::time,time '09:00');
  v_grace:=greatest(0,least(240,coalesce((v_org.settings->>'lateGraceMinutes')::integer,5)));
  v_late:=greatest(0,floor(extract(epoch FROM(v_local::time-v_shift_start))/60)::integer-v_grace);
  INSERT INTO public.attendance(organization_id,employee_id,work_date,check_in_at,status,attendance_type,check_in_location_id,late_minutes)
  VALUES(p_organization_id,v_employee.id,v_date,now(),CASE WHEN p_attendance_type='REMOTE' THEN 'REMOTE_WORK'::"AttendanceStatus" WHEN v_late>0 THEN 'LATE'::"AttendanceStatus" ELSE 'IN_PROGRESS'::"AttendanceStatus" END,p_attendance_type,v_location.id,v_late)
  ON CONFLICT(organization_id,employee_id,work_date) DO NOTHING RETURNING * INTO v_attendance;
  IF v_attendance.id IS NULL THEN RAISE EXCEPTION 'attendance has already started for this work date' USING ERRCODE='23505'; END IF;
  INSERT INTO public.attendance_events(organization_id,attendance_id,employee_id,actor_employee_id,location_id,type,latitude,longitude,accuracy_meters,distance_meters,ip_hash,browser,device,request_id)
  VALUES(p_organization_id,v_attendance.id,v_employee.id,v_employee.id,v_location.id,'CHECK_IN',p_latitude,p_longitude,p_accuracy_meters,
    CASE WHEN v_location.id IS NULL THEN NULL ELSE public.distance_meters(v_location.latitude::float8,v_location.longitude::float8,p_latitude::float8,p_longitude::float8) END,
    left(p_ip_hash,128),left(p_browser,160),left(p_device,160),left(p_request_id,80));
  RETURN v_attendance;
END $$;

CREATE OR REPLACE FUNCTION public.create_organization_for_current_user(
  p_name text, p_slug text, p_timezone text, p_employee_number text,
  p_full_name text, p_email text, p_designation text
) RETURNS TABLE (organization_id uuid, employee_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, extensions, pg_temp AS $$
DECLARE v_org uuid; v_employee uuid; v_claims jsonb := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
BEGIN
  IF auth.uid() IS NULL OR lower(coalesce(v_claims->>'email_verified','false')) <> 'true'
    OR lower(coalesce(v_claims->>'email','')) <> lower(p_email) THEN
    RAISE EXCEPTION 'verified account required' USING ERRCODE='42501';
  END IF;
  IF length(trim(p_name)) NOT BETWEEN 2 AND 160 OR length(trim(p_full_name)) NOT BETWEEN 2 AND 160
    OR p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR length(p_slug) > 80 THEN
    RAISE EXCEPTION 'invalid organization details' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM pg_timezone_names WHERE name = p_timezone;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown time zone' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM public.employees WHERE supabase_user_id=auth.uid()) THEN
    RAISE EXCEPTION 'account already belongs to an organization' USING ERRCODE='23505';
  END IF;
  INSERT INTO public.organizations(name,slug,timezone) VALUES(trim(p_name),p_slug,p_timezone) RETURNING id INTO v_org;
  INSERT INTO public.employees(organization_id,supabase_user_id,employee_number,full_name,email,designation,role,status)
  VALUES(v_org,auth.uid(),trim(p_employee_number),trim(p_full_name),lower(trim(p_email)),trim(p_designation),'ADMINISTRATOR','ACTIVE') RETURNING id INTO v_employee;
  RETURN QUERY SELECT v_org,v_employee;
END $$;

CREATE OR REPLACE FUNCTION public.redeem_employee_invite(p_code_hash text,p_full_name text,p_phone text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, pg_temp AS $$
DECLARE v_invite public.organization_invites; v_employee uuid; v_claims jsonb := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
BEGIN
  IF auth.uid() IS NULL OR lower(coalesce(v_claims->>'email_verified','false')) <> 'true' THEN
    RAISE EXCEPTION 'verified account required' USING ERRCODE='42501';
  END IF;
  IF length(trim(p_full_name)) NOT BETWEEN 2 AND 160 OR (p_phone IS NOT NULL AND length(trim(p_phone)) NOT BETWEEN 1 AND 32) THEN
    RAISE EXCEPTION 'invalid employee details' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_invite FROM public.organization_invites
    WHERE code_hash=p_code_hash AND redeemed_at IS NULL AND expires_at>now()
      AND lower(email)=lower(coalesce(v_claims->>'email','')) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invitation invalid or expired' USING ERRCODE='P0001'; END IF;
  IF EXISTS (SELECT 1 FROM public.employees WHERE supabase_user_id=auth.uid()) THEN
    RAISE EXCEPTION 'account already linked to an organization' USING ERRCODE='23505';
  END IF;
  INSERT INTO public.employees(organization_id,supabase_user_id,employee_number,full_name,email,phone,department_id,designation,status)
  VALUES(v_invite.organization_id,auth.uid(),v_invite.employee_number,trim(p_full_name),lower(v_invite.email),nullif(trim(p_phone),''),v_invite.department_id,v_invite.designation,'ACTIVE')
  RETURNING id INTO v_employee;
  UPDATE public.organization_invites SET redeemed_at=now() WHERE id=v_invite.id;
  INSERT INTO public.attendance_events(organization_id,employee_id,actor_employee_id,type,metadata)
  VALUES(v_invite.organization_id,v_employee,v_employee,'EMPLOYEE_CREATED','{"source":"invite"}'::jsonb);
  RETURN v_employee;
END $$;

CREATE OR REPLACE FUNCTION public.attendance_check_out(
  p_organization_id uuid,p_latitude numeric,p_longitude numeric,p_ip_hash text DEFAULT NULL,
  p_browser text DEFAULT NULL,p_device text DEFAULT NULL,p_request_id text DEFAULT NULL,p_accuracy_meters numeric DEFAULT NULL
) RETURNS public.attendance
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, pg_temp AS $$
DECLARE v_employee public.employees; v_org public.organizations; v_location public.office_locations; v_attendance public.attendance;
BEGIN
  SELECT * INTO v_employee FROM public.employees WHERE organization_id=p_organization_id AND supabase_user_id=auth.uid() AND status='ACTIVE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'active employee membership required' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_org FROM public.organizations WHERE id=p_organization_id;
  SELECT * INTO v_attendance FROM public.attendance WHERE organization_id=p_organization_id AND employee_id=v_employee.id
    AND check_in_at IS NOT NULL AND check_out_at IS NULL ORDER BY work_date DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND OR v_attendance.check_in_at IS NULL THEN RAISE EXCEPTION 'check in before checking out' USING ERRCODE='P0001'; END IF;
  IF v_attendance.check_out_at IS NOT NULL THEN RAISE EXCEPTION 'already checked out' USING ERRCODE='23505'; END IF;
  IF v_attendance.attendance_type='OFFICE' THEN
    IF p_latitude IS NULL OR p_longitude IS NULL OR p_accuracy_meters IS NULL OR p_accuracy_meters<=0
      OR p_accuracy_meters>coalesce((v_org.settings->>'maxGpsAccuracyMeters')::numeric,100) THEN
      RAISE EXCEPTION 'valid GPS coordinates and accuracy required' USING ERRCODE='22023';
    END IF;
    SELECT l.* INTO v_location FROM public.office_locations l WHERE l.organization_id=p_organization_id AND l.active
      AND public.distance_meters(l.latitude::float8,l.longitude::float8,p_latitude::float8,p_longitude::float8)<=l.radius_meters
      ORDER BY public.distance_meters(l.latitude::float8,l.longitude::float8,p_latitude::float8,p_longitude::float8) LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'outside authorized location' USING ERRCODE='42501'; END IF;
  END IF;
  UPDATE public.attendance SET check_out_at=now(),total_work_minutes=floor(extract(epoch FROM(now()-v_attendance.check_in_at))/60)::integer,
    status=CASE WHEN v_attendance.attendance_type='REMOTE' THEN 'REMOTE_WORK'::"AttendanceStatus" WHEN v_attendance.status='LATE' THEN 'LATE'::"AttendanceStatus" ELSE 'PRESENT'::"AttendanceStatus" END
    WHERE id=v_attendance.id RETURNING * INTO v_attendance;
  INSERT INTO public.attendance_events(organization_id,attendance_id,employee_id,actor_employee_id,location_id,type,latitude,longitude,accuracy_meters,distance_meters,ip_hash,browser,device,request_id)
  VALUES(p_organization_id,v_attendance.id,v_employee.id,v_employee.id,v_location.id,'CHECK_OUT',p_latitude,p_longitude,p_accuracy_meters,
    CASE WHEN v_location.id IS NULL THEN NULL ELSE public.distance_meters(v_location.latitude::float8,v_location.longitude::float8,p_latitude::float8,p_longitude::float8) END,
    left(p_ip_hash,128),left(p_browser,160),left(p_device,160),left(p_request_id,80));
  RETURN v_attendance;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS attendance_events_idempotency_key_unique
  ON public.attendance_events(organization_id,employee_id,type,request_id)
  WHERE request_id IS NOT NULL AND type IN ('CHECK_IN','CHECK_OUT');

CREATE OR REPLACE FUNCTION public.capture_invite_audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, pg_temp AS $$
DECLARE v_old jsonb; v_new jsonb; v_org uuid; v_actor uuid;
BEGIN
  IF TG_OP='UPDATE' THEN v_old:=to_jsonb(OLD)-'code_hash'; END IF;
  v_new:=to_jsonb(NEW)-'code_hash';
  v_org:=NEW.organization_id;
  v_actor:=CASE WHEN auth.uid() IS NULL THEN NULL ELSE public.current_employee_id(v_org) END;
  INSERT INTO public.audit_logs(organization_id,actor_employee_id,action,entity_type,entity_id,previous_values,new_values)
  VALUES(v_org,v_actor,lower(TG_OP)||'.organization_invites','organization_invites',NEW.id::text,v_old,v_new);
  RETURN NEW;
END $$;

CREATE TRIGGER organizations_audit_insert AFTER INSERT ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.capture_audit_row();
CREATE TRIGGER organization_invites_audit AFTER INSERT OR UPDATE ON public.organization_invites
  FOR EACH ROW EXECUTE FUNCTION public.capture_invite_audit_row();

REVOKE ALL ON FUNCTION public.attendance_check_in(uuid,numeric,numeric,numeric,text,text,text,text,"AttendanceType") FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.attendance_check_in(uuid,numeric,numeric,numeric,text,text,text,text,"AttendanceType") TO authenticated;
REVOKE ALL ON FUNCTION public.create_organization_for_current_user(text,text,text,text,text,text,text) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.redeem_employee_invite(text,text,text) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.attendance_check_out(uuid,numeric,numeric,text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.create_organization_for_current_user(text,text,text,text,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_employee_invite(text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_check_out(uuid,numeric,numeric,text,text,text,text,numeric) TO authenticated;
