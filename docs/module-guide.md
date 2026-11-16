# Module and file guide

This guide describes files currently present in the AttendFlow application. The repository's root `index.html`, `script.js`, `styles.css`, and `attendflow-zip/` are unrelated artifacts and are not runtime inputs.

## Architecture

- `apps/web/app/` — Next.js App Router entry point, document shell, and global Tailwind styles.
- `apps/web/components/dashboard.tsx` — current authenticated employee/admin screens. It calls only the `/workforce/*` API and covers login, registration, organization bootstrap, invitations, attendance, employee WFH permissions, departments, office locations, and CSV history export.
- `apps/web/next.config.ts` — security headers and an environment-derived Content Security Policy.
- `apps/api/src/workforce.controller.ts` — Nest HTTP routes and strict request DTOs; it delegates application behavior to the service.
- `apps/api/src/workforce/workforce.service.ts` — use cases, membership checks, administrator authorization, policy validation, and tenant-filtered data access.
- `apps/api/src/domain/attendance-policy.js` and `.d.ts` — dependency-free work-date, geofence, work-duration, and daily summary rules.
- `apps/api/src/auth.guard.ts` and `apps/api/src/auth/supabase-auth.service.ts` — bearer-token authentication through Supabase Auth and the request principal.
- `apps/api/src/prisma.service.ts` — Prisma lifecycle and transaction-local `authenticated` role/JWT claims for PostgreSQL RLS.
- `apps/api/src/app.module.ts` and `main.ts` — provider registration, global rate limiting, validation, CORS, security headers, request IDs/logging, and graceful Nest shutdown.
- `apps/api/src/health.controller.ts`, `metrics*.ts`, `redis-throttler.storage.ts`, and `sentry-exception.filter.ts` — readiness, Prometheus metrics, Redis-backed throttling, and sanitized errors/Sentry reporting.

## Database

- `prisma/schema.prisma` — normalized Prisma data model for organizations, departments, employees, office locations, attendance, audit, invites, sessions, and notifications.
- `prisma/migrations/202611130001_initial_workforce_schema/migration.sql` — initial PostgreSQL tables, indexes, constraints, RLS policies, audit triggers, and attendance check-in function.
- `prisma/migrations/202611140001_employee_wfh_permission/migration.sql` — employee WFH permission and lookup index.
- `prisma/migrations/202611160001_production_api_functions/migration.sql` — verified organization bootstrap, invitation redemption, geofenced check-out, retry-key index, and audit triggers.
- `prisma/rollback/202611160001_production_api_functions.rollback.sql` — conservative emergency rollback that revokes the new endpoints without restoring the older no-geofence check-out function.
- `prisma/seed.cjs` — development seed for an existing Supabase Auth user; refuses to run in production and does not create passwords.

## Tests, build, and deployment

- `apps/api/test/attendance-policy.test.cjs` — native Node unit tests for date parsing, time zones, geofence distance, office selection, work minutes, and summaries.
- `apps/api/Dockerfile` — multi-stage API image used by Railway.
- `.github/workflows/ci.yml` — dependency install, Prisma client generation, tests, type checks, builds, and opt-in Vercel deployment.
- `.env.example` — local environment variable names. Production secrets belong in Railway/Vercel secret managers.
- `docs/architecture.md` — architecture, boundaries, and implemented API contract.
- `docs/deployment.md` — local setup, provider configuration, migration release process, and staging checks.

The current release does not include browser E2E or database integration suites, calendar-grid UI, leave workflows, shift schedules, or a browsable audit-log screen. Do not use those paths as deployed features.
