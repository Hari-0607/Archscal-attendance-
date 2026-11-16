-- Emergency rollback for 202611160001_production_api_functions.
-- This deliberately revokes the new write entry points and leaves the older
-- check-out overload revoked. Re-enabling the former no-geofence function is
-- not a safe rollback. Restore the prior application release only after it no
-- longer calls these APIs, then deploy a reviewed forward fix.
REVOKE ALL ON FUNCTION public.create_organization_for_current_user(text,text,text,text,text,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.redeem_employee_invite(text,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.attendance_check_out(uuid,numeric,numeric,text,text,text,text,numeric) FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS organization_invites_audit ON public.organization_invites;
DROP TRIGGER IF EXISTS organizations_audit_insert ON public.organizations;
DROP FUNCTION IF EXISTS public.capture_invite_audit_row();
DROP INDEX IF EXISTS public.attendance_events_idempotency_key_unique;
