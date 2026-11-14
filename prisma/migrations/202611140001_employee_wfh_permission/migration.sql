-- WFH is an employee-level permission. A client cannot enable it by choosing REMOTE.
ALTER TABLE employees
  ADD COLUMN wfh_enabled boolean NOT NULL DEFAULT false;

CREATE INDEX employees_org_wfh_status_idx
  ON employees (organization_id, wfh_enabled, status);
