# AttendFlow setup and deployment

This guide describes deployment of the current Prisma-backed API and its matching Next.js interface. Treat production deployment as blocked until a staging project has run the migrations and passed the integration, security, and browser checks in the release checklist.

## Local development

1. Install Node.js 20.11+ and create a Supabase project. Enable email/password sign-in and email verification. Configure production redirect URLs only for deployed origins.
2. Copy `.env.example` to `.env`. Set the Supabase project URL and public anon key, the Supabase PostgreSQL pooled `DATABASE_URL` for runtime, and direct `DIRECT_URL` for migrations. Keep database credentials, Sentry DSNs and metrics/Redis secrets out of source control.
3. Copy `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1` into `apps/web/.env.local`.
4. Run `npm install`, then `npm run db:generate`, then `npm run db:migrate:deploy`.
5. Start the frontend and API with `npm run dev`. Web runs on port 3000 and the API on port 4000.

The initial SQL migration references `auth.users`; use a Supabase project rather than an empty local PostgreSQL instance. To use a local Supabase stack, start it with the Supabase CLI first and use its database URLs.

## Supabase database and Auth

- Apply migrations in order with `npm run db:migrate:deploy`. Review the generated migration SQL in a non-production project first and take a backup before any production schema change.
- The first administrator creates an organization only from a verified Supabase Auth identity. `npm run db:seed --workspace @attendflow/api` is development-only and requires an existing Auth user; it refuses `NODE_ENV=production`.
- Supabase Auth owns passwords, verification, recovery and token refresh. The API validates the access token via Supabase Auth and maps its subject to `employees.supabase_user_id`.
- Each application transaction uses `SET LOCAL ROLE authenticated` and sets the verified user's JWT claims before Prisma queries, so PostgreSQL RLS applies. Configure the runtime connection so it can assume only the `authenticated` role; do not expose a database owner credential to the request-serving process. Test this role setup with the selected Supabase pooler before release.

## Railway API

Create a Railway service from the GitHub repository with the repository root as its source directory. Set the service variable `RAILWAY_DOCKERFILE_PATH=apps/api/Dockerfile` so Railway uses the API container in this monorepo. Set the healthcheck path to `/api/v1/health/ready`. Set:

- `NODE_ENV=production`
- `PORT` to Railway's injected port (the app defaults to `4000`)
- `DATABASE_URL` to the Supabase pooled PostgreSQL URL, with a conservative connection limit based on Railway replicas and Supabase capacity
- `DIRECT_URL` for schema migration jobs, not public request traffic
- `SUPABASE_URL` and `SUPABASE_ANON_KEY`
- `CORS_ORIGINS` to exact HTTPS Vercel origins, comma-separated
- `REDIS_URL` (required in production), `IP_HASH_SECRET` (random secret of at least 32 bytes), and optional `SENTRY_DSN`
- `TRUST_PROXY_HOPS=1` when Railway is the single trusted reverse proxy

Create the non-owner request role in Supabase once with [`infra/supabase/create-runtime-role.sql`](../infra/supabase/create-runtime-role.sql). Generate a unique password, pass it to `psql` as the `runtime_password` variable without saving it to the repository, and set Railway's pooled `DATABASE_URL` to this role. Keep the owner connection string in a protected one-off migration job as `DIRECT_URL`; do not configure that privileged URL as an API service variable. Verify the runtime role can `SET ROLE authenticated` and cannot create roles, tables, or bypass RLS.

Configure `/api/v1/health/ready` as the Railway readiness probe. The production bootstrap requires Redis for shared rate limiting. Apply Prisma migrations as a release/deploy step with `npm run db:migrate:deploy`, not on every API replica startup. Keep Railway's API origin private to the app where possible and enforce HTTPS.

## Vercel frontend

Import `apps/web` as the Vercel project root and set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `NEXT_PUBLIC_API_URL=https://<railway-api-domain>/api/v1`. Add the final Vercel URL to Supabase Auth's allowed redirect URLs and to Railway `CORS_ORIGINS`. Preview deployments should use a separate Supabase project or carefully scoped preview credentials.

The web interface is limited to the API-backed attendance, invite, employee, department, location, and CSV flows. Leave management, shift scheduling, audit browsing, calendar grids, and richer reporting are not available in this release.

The API runtime audit is clean when optional/dev tooling is excluded. The web runtime audit still flags Next.js 15.5.29's nested PostCSS 8.4.31 dependency. The audit tool offers only a Next.js 16 upgrade; keep the requested Next.js 15 version and treat this as a production release blocker until a reviewed compatible fix is available.

## Release checklist

1. Apply migrations to a staging Supabase project and confirm the migration table and RLS policies.
2. Create the first administrator using the approved bootstrap procedure and confirm invite redemption with verified email.
3. Verify office GPS boundaries, low-accuracy GPS rejection, WFH permission gating, duplicate check-in, checkout, admin correction, employee-only history and cross-organization access behavior.
4. Confirm Vercel CORS/origin and Supabase Auth redirect configuration; validate Railway readiness and Redis-backed rate limiting.
5. Review backup/PITR and retention settings, structured logs, Sentry alert routing and secrets rotation. Do not log raw coordinates, tokens, passwords, or raw IP addresses.
6. Run representative concurrency and failure testing before setting a capacity target. The earlier 10,000-user figure is an unvalidated objective.
7. Deploy API and web from pinned commits; monitor health and error rates, and retain a rollback image and database recovery plan.

Do not promote to production while the web dependency audit reports the unresolved high-severity advisory above.
