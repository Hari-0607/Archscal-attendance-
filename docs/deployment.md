# AttendFlow setup and deployment

This guide describes the target deployment and the current repository's implemented steps. The Prisma API routes are an initial module; the existing dashboard still calls the legacy API. Complete that integration and the RLS request context described in `architecture.md` before routing production traffic.

## Local development

1. Install Node.js 20.11+ and create a Supabase project. Enable email/password sign-in and email verification. Configure production redirect URLs only for deployed origins.
2. Copy `.env.example` to `.env`. Set the Supabase project URL and public anon key, the Supabase PostgreSQL pooled `DATABASE_URL` for runtime, and direct `DIRECT_URL` for migrations. Keep database credentials, Sentry DSNs and metrics/Redis secrets out of source control.
3. Copy `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1` into `apps/web/.env.local`.
4. Run `npm install`, then `npm run db:generate`, then `npm run db:migrate:deploy`.
5. Start the frontend and API with `npm run dev`. Web runs on port 3000 and the API on port 4000.

The initial SQL migration references `auth.users`; use a Supabase project rather than an empty local PostgreSQL instance. To use a local Supabase stack, start it with the Supabase CLI first and use its database URLs.

## Supabase database and Auth

- Apply migrations in order with `npm run db:migrate:deploy`. Review the generated migration SQL in a non-production project first and take a backup before any production schema change.
- The first organization administrator needs a controlled bootstrap path. The initial Prisma module does not yet provide a secure first-admin bootstrap endpoint or seed command; provision that identity through a reviewed one-time operator procedure.
- Supabase Auth owns passwords, verification, recovery and token refresh. The API validates the access token via Supabase Auth and maps its subject to `employees.supabase_user_id`.
- The Prisma service currently uses direct ORM queries. Do not provide a database owner/bypass-RLS credential to a publicly reachable API. Configure a dedicated constrained database role and implement request-scoped RLS claims before production.

## Railway API

Create a Railway service from the GitHub repository with the repository root as its source directory. Set the service variable `RAILWAY_DOCKERFILE_PATH=apps/api/Dockerfile` so Railway uses the API container in this monorepo. Set the healthcheck path to `/api/v1/health/ready`. Set:

- `NODE_ENV=production`
- `PORT` to Railway's injected port (the app defaults to `4000`)
- `DATABASE_URL` to the Supabase pooled PostgreSQL URL, with a conservative connection limit based on Railway replicas and Supabase capacity
- `DIRECT_URL` for schema migration jobs, not public request traffic
- `SUPABASE_URL` and `SUPABASE_ANON_KEY`
- `CORS_ORIGINS` to the exact Vercel production origin(s), comma-separated
- `REDIS_URL` and `SENTRY_DSN` when the production throttle store and error tracking are enabled

Configure `/api/v1/health/ready` as the Railway readiness probe. The production bootstrap requires Redis for shared rate limiting. Apply Prisma migrations as a release/deploy step with `npm run db:migrate:deploy`, not on every API replica startup. Keep Railway's API origin private to the app where possible and enforce HTTPS.

## Vercel frontend

Import `apps/web` as the Vercel project root and set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `NEXT_PUBLIC_API_URL=https://<railway-api-domain>/api/v1`. Add the final Vercel URL to Supabase Auth's allowed redirect URLs and to Railway `CORS_ORIGINS`. Preview deployments should use a separate Supabase project or carefully scoped preview credentials.

The current web dashboard still uses legacy organization and attendance endpoints. Confirm every frontend route and payload matches the Prisma API before enabling a production deployment; configure CI deployment only after a staging smoke pass.

## Release checklist

1. Apply migrations to a staging Supabase project and confirm the migration table and RLS policies.
2. Create the first administrator using the approved bootstrap procedure and confirm invite redemption with verified email.
3. Verify office GPS boundaries, low-accuracy GPS rejection, WFH permission gating, duplicate check-in, checkout, admin correction, employee-only history and cross-organization access behavior.
4. Confirm Vercel CORS/origin and Supabase Auth redirect configuration; validate Railway readiness and Redis-backed rate limiting.
5. Review backup/PITR and retention settings, structured logs, Sentry alert routing and secrets rotation. Do not log raw coordinates, tokens, passwords, or raw IP addresses.
6. Run representative concurrency and failure testing before setting a capacity target. The earlier 10,000-user figure is an unvalidated objective.
7. Deploy API and web from pinned commits; monitor health and error rates, and retain a rollback image and database recovery plan.
