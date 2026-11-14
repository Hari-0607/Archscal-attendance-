# Module and file guide

This guide explains the AttendFlow application files in the workspace. Root `index.html`, `script.js`, and `styles.css` are an unrelated static site and are not part of the attendance system. The extracted `attendflow-zip/` directory is also not a runtime dependency.

## System architecture

The browser runs the Next.js app on Vercel and obtains Supabase Auth access tokens. It sends bearer tokens to the NestJS API on Railway. The API validates identity with Supabase Auth, authorizes the employee against an organization in Prisma, and stores business data in Supabase PostgreSQL. Prisma migrations define tables, constraints and database functions. Redis supplies shared API throttling; Prometheus and Grafana provide optional operations monitoring. See [architecture.md](architecture.md) for the diagrams and boundaries and [deployment.md](deployment.md) for the release setup.

## Employee and admin modules

### Authentication and employee lifecycle

- `apps/web/components/dashboard.tsx` — existing client-side app shell, Supabase sign-in/sign-up/recovery/MFA flows, organization selection and dashboard screens. It still calls the older API contract and must be migrated to `/workforce/*` before production.
- `apps/api/src/auth.guard.ts` — validates bearer access tokens with Supabase Auth and attaches the authenticated user to the Nest request.
- `apps/api/src/workforce.controller.ts` — `GET /workforce/me`, administrator invitation creation, and authenticated invitation redemption tied to the verified Auth email.
- `prisma/schema.prisma` — `Organization`, `Employee`, `Department`, `OrganizationInvite`, `UserSession` and related enums/relations.

### Attendance and WFH

- `apps/api/src/workforce.controller.ts` — GPS accuracy and office-radius checks, employee WFH permission checks, attendance history, check-in/out, late status calculation, admin dashboard aggregates, and reasoned admin corrections. Attendance events and audit rows are written in the same Prisma transaction as the attendance change.
- `prisma/schema.prisma` — `AttendanceRecord`, `AttendanceEvent`, `OfficeLocation`, `AttendanceStatus`, and `AttendanceType` models.
- `prisma/migrations/202611130001_initial_workforce_schema/migration.sql` — initial tables, constraints, indexes, RLS policies and database functions.
- `prisma/migrations/202611140001_employee_wfh_permission/migration.sql` — employee-level WFH opt-in flag and lookup index.
- `apps/web/components/module-page.tsx` — existing dashboard module presentation and data tables, still on the previous API model.

### Admin management

- `apps/api/src/workforce.controller.ts` — create departments and office geofences, list employees, toggle WFH permission with an audit row, and correct attendance with a reason.
- `prisma/schema.prisma` — department and location organization-scoped keys prevent cross-tenant references.
- `apps/web/components/dashboard.tsx` — existing admin navigation and dashboards; data contract integration remains outstanding.

## Backend foundation and operations

- `apps/api/src/main.ts` — Nest bootstrap, security headers, CORS, validation, request IDs, structured request logs and global API prefix.
- `apps/api/src/app.module.ts` — registers controllers, guards, Prisma/Supabase providers, throttling, metrics and error filtering.
- `apps/api/src/prisma.service.ts` — Prisma client connection lifecycle.
- `apps/api/src/supabase.service.ts` — creates Supabase clients scoped to the incoming bearer token for the legacy API controller.
- `apps/api/src/attendance.controller.ts` — legacy Supabase-JS controller for the earlier schema; keep separate from the Prisma API migration work.
- `apps/api/src/health.controller.ts` — liveness response and database-backed readiness check.
- `apps/api/src/metrics.ts` — Prometheus registry and request metrics.
- `apps/api/src/metrics.interceptor.ts` — records HTTP request count/latency metrics.
- `apps/api/src/metrics.controller.ts` — protected Prometheus scrape endpoint.
- `apps/api/src/redis-throttler.storage.ts` — Redis-backed Nest rate limit storage.
- `apps/api/src/sentry-exception.filter.ts` — captures API exceptions in Sentry when configured and formats HTTP errors.
- `apps/api/package.json` — Nest, Prisma and API scripts/dependencies.
- `apps/api/tsconfig.json` — strict TypeScript compiler settings.
- `apps/api/nest-cli.json` — Nest build configuration.
- `apps/api/Dockerfile` — multi-stage Railway/container build for the API.

## Web app

- `apps/web/app/page.tsx` — root route rendering the dashboard client.
- `apps/web/app/layout.tsx` — document shell and metadata.
- `apps/web/app/globals.css` — Tailwind import and global palette/base styles.
- `apps/web/components/dashboard.tsx` — employee/admin screens and Auth user flows.
- `apps/web/components/module-page.tsx` — detailed admin module tables and controls.
- `apps/web/instrumentation-client.ts` — client-side monitoring setup.
- `apps/web/next.config.ts` — Next.js configuration.
- `apps/web/postcss.config.mjs` — Tailwind/PostCSS integration.
- `apps/web/eslint.config.mjs` — ESLint rules.
- `apps/web/tsconfig.json` — TypeScript and app alias configuration.
- `apps/web/package.json` — frontend scripts and dependencies.
- `apps/web/vercel.json` — Vercel deployment configuration.

## Database, deployment and monitoring

- `prisma/schema.prisma` — ORM source of truth for organizations, employees, departments, office locations, attendance, audit, invites, sessions and notifications.
- `prisma/migrations/migration_lock.toml` — locks Prisma migration provider to PostgreSQL.
- `supabase/migrations/202611130001_workforce_platform.sql` — earlier, separate workforce schema used by the legacy API. It is not the Prisma migration chain; do not apply both schema families to production without a reconciliation migration plan.
- `docker-compose.yml` — optional local API, Redis, Prometheus, Grafana, Elasticsearch and Kibana services.
- `infra/prometheus/prometheus.yml` — Prometheus scrape and metrics-token configuration.
- `infra/grafana/provisioning/datasources/prometheus.yml` — configures Grafana's Prometheus data source.
- `infra/grafana/provisioning/dashboards/dashboards.yml` — loads the checked-in operations dashboard.
- `infra/grafana/dashboards/attendflow-operations.json` — API operations dashboard panels.
- `.env.example` — variable names and local example values; replace placeholders and never commit secrets.
- `package.json` — npm workspaces and root development/build/database scripts.
- `.github/workflows/ci.yml` — CI build and opt-in Vercel deployment workflow.
- `.gitignore` — excludes local credentials and generated/runtime files.
- `docs/architecture.md` — requirements, diagrams, target API contracts, implemented API routes and known gaps.
- `docs/deployment.md` — environment setup, deployment and release checklist.
- `README.md` — project overview and quick start.
