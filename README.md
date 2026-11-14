# AttendFlow

AttendFlow is an employee attendance management system built around **Next.js 15**, **NestJS**, **Supabase Auth**, **Supabase PostgreSQL**, and **Prisma**. Employees register through an administrator invitation, check in and out, request office or approved WFH attendance, and review their history. Administrators manage invitations, departments, office locations and WFH permissions, and review attendance summaries.

## Project map

- [`docs/architecture.md`](docs/architecture.md) — architecture, data model, security boundaries, diagrams, API contracts, and module/file guide.
- [`docs/deployment.md`](docs/deployment.md) — local setup and Vercel, Railway and Supabase deployment steps.
- [`docs/module-guide.md`](docs/module-guide.md) — module-by-module explanation of the application files.
- [`prisma/schema.prisma`](prisma/schema.prisma) — normalized business data models.
- [`prisma/migrations/`](prisma/migrations/) — initial schema and database invariants.
- [`apps/api/src/workforce.controller.ts`](apps/api/src/workforce.controller.ts) — Prisma-backed attendance and admin API routes.
- [`apps/web/`](apps/web/) — Next.js web application and dashboard UI.

## Local setup

1. Use Node.js 20.11 or newer and create a Supabase project with email/password authentication enabled.
2. Copy `.env.example` to the root `.env`; set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `DATABASE_URL`, `DIRECT_URL`, and a local `CORS_ORIGINS` value. Copy the `NEXT_PUBLIC_*` variables into `apps/web/.env.local`.
3. Install dependencies with `npm install`.
4. Generate the ORM client and apply the schema: `npm run db:generate` then `npm run db:migrate:deploy`.
5. Start the workspaces with `npm run dev`.

Supabase's `auth.users` table is referenced by the migration. This schema is not a generic PostgreSQL bootstrap. See the deployment guide for production secrets, networking, migrations, and health checks.

## Delivery status

The repository contains the architecture and Prisma model, database migrations, a Supabase JWT guard, a Prisma service, and initial Prisma-backed workforce routes. It also contains a substantial earlier UI and a legacy Supabase-JS API scaffold. **Those legacy UI/API paths have not yet been fully migrated to the Prisma contract**, and the application has not been built against a live Supabase project or deployed. Treat this as an implementation foundation, not a production launch. The docs identify the remaining integration and operational work.
