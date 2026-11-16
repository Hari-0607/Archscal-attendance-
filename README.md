# AttendFlow

AttendFlow is an employee attendance management system built around **Next.js 15**, **NestJS**, **Supabase Auth**, **Supabase PostgreSQL**, and **Prisma**. Employees register through an administrator invitation, check in and out, request office or approved WFH attendance, and review their history. Administrators manage invitations, departments, office locations and WFH permissions, and review attendance summaries.

## Project map

- [`docs/architecture.md`](docs/architecture.md) — architecture, data model, security boundaries, diagrams, API contracts, and module/file guide.
- [`docs/deployment.md`](docs/deployment.md) — local setup and Vercel, Railway and Supabase deployment steps.
- [`docs/module-guide.md`](docs/module-guide.md) — module-by-module explanation of the application files.
- [`prisma/schema.prisma`](prisma/schema.prisma) — normalized business data models.
- [`prisma/migrations/`](prisma/migrations/) — initial schema and database invariants.
- [`apps/api/src/workforce.controller.ts`](apps/api/src/workforce.controller.ts) — versioned HTTP routes and request DTOs.
- [`apps/api/src/workforce/workforce.service.ts`](apps/api/src/workforce/workforce.service.ts) — organization-scoped use cases and RLS-aware Prisma transactions.
- [`apps/web/`](apps/web/) — Next.js web application and dashboard UI.

## Local setup

1. Use Node.js 20.11 or newer and create a Supabase project with email/password authentication enabled.
2. Copy `.env.example` to the root `.env`; set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `DATABASE_URL`, `DIRECT_URL`, and a local `CORS_ORIGINS` value. Copy the `NEXT_PUBLIC_*` variables into `apps/web/.env.local`.
3. Install dependencies with `npm install`.
4. Generate the ORM client and apply the schema: `npm run db:generate` then `npm run db:migrate:deploy`.
5. Start the workspaces with `npm run dev`.

Supabase's `auth.users` table is referenced by the migration. This schema is not a generic PostgreSQL bootstrap. See the deployment guide for production secrets, networking, migrations, and health checks.

## Readiness status

The active API and web screens now use the workforce contract; the incompatible legacy API and schema were removed. The repository includes RLS-scoped Prisma transactions, Supabase Auth token verification, role checks, attendance security functions, migration rollback instructions, health/readiness checks, throttling, request logs, Sentry hooks, Prometheus metrics, and native Node policy tests.

This is **not yet certified for production traffic**. Unit tests, TypeScript checks, and optimized API/web builds pass, but the migrations have not been applied or exercised against Supabase; there are no live API integration or browser E2E tests or representative load results. The frontend audit advisory below also blocks release. Resolve these items in staging, configure the production secrets described in [`docs/deployment.md`](docs/deployment.md), then deploy a reviewed commit.

The current npm audit reports **one high-severity advisory in the Next.js 15 runtime tree**: Next.js 15.5.29 pins vulnerable PostCSS 8.4.31. npm only offers an automatic fix by upgrading Next.js to 16, which conflicts with the requested Next.js 15 stack. The API runtime dependency tree audits clean; resolve the frontend advisory or approve the framework upgrade before production traffic.

Run `npm test` for the dependency-free date, geofence, work-duration, and daily summary tests. `npm run db:seed --workspace @attendflow/api` can seed a development organization for an existing Supabase Auth user; it refuses to run when `NODE_ENV=production`.
