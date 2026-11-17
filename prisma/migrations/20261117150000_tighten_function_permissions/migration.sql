-- Keep SECURITY DEFINER entry points unavailable to anonymous callers.
-- Authenticated entry points retain the JWT and membership checks in each body.
REVOKE EXECUTE ON FUNCTION public.admin_correct_attendance(uuid,uuid,timestamptz,timestamptz,"AttendanceStatus",text,text,text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.attendance_check_out(uuid,numeric,numeric,text,text,text,text,numeric) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.capture_audit_row() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.capture_invite_audit_row() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.current_employee_id(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.current_employee_role(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.start_user_session(uuid,text,text,text,text,numeric,numeric) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.end_user_session(uuid,text,text,text,text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.current_employee_id(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_employee_role(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_check_in(uuid,numeric,numeric,numeric,text,text,text,text,"AttendanceType") TO authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_check_out(uuid,numeric,numeric,text,text,text,text,numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_organization_for_current_user(text,text,text,text,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_employee_invite(text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_correct_attendance(uuid,uuid,timestamptz,timestamptz,"AttendanceStatus",text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.start_user_session(uuid,text,text,text,text,numeric,numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.end_user_session(uuid,text,text,text,text) TO authenticated;

ALTER FUNCTION public.distance_meters(double precision,double precision,double precision,double precision)
  SET search_path = pg_catalog;
