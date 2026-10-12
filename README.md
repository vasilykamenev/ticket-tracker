# Support Ticket Tracker (com.berney)

An internal tool for a support team: customer requests are entered by staff, worked through a fixed workflow by
agents, and administered by admins. AdminJS + Express + Prisma on Supabase PostgreSQL and Storage, delivered as one
Docker container behind Caddy (automatic HTTPS) on a VPS.

- **Live:** https://3130058.vpsnet.cloud (sign in at `/admin`). Reviewer accounts are shared separately; the repository holds no passwords.
- **Requirements:** `docs/Support_Ticket_Tracker_Requirements_EN_v1.1.md` · **Decisions:** `docs/decisions.md` · **Progress and evidence:** `docs/acceptance.md` · **Notes for the review:** `docs/review.md`

## What it does

- **Tickets** with a subject, description (up to 1000 characters), priority, customer, group, assignee, status, resolution or unresolved reason, and a full history. Lists have search, filters, sorting and pagination (checked with 2000 tickets).
- **A fixed workflow** of six system statuses (NEW, IN_PROGRESS, WAITING_CUSTOMER, RESOLVED, UNRESOLVED, CLOSED) with an explicit transition matrix, required reasons and ADMIN-only steps. Every change is one transaction: the ticket, its version and its history entry.
- **My open tickets** in the side menu: the ticket list filtered to the signed-in agent as the assignee and every status except CLOSED (the status filter accepts `__open__` for that). AdminJS can only put a page in the menu, so the entry is a small page that sends the person on to the filtered list. Administrators have no agent profile, so they get a short explanation and use the Tickets list.
- **Inline comments** on the ticket page (create, edit by the author or an admin, never on CLOSED or UNRESOLVED tickets) and **attachments** (PNG, JPEG, PDF, UTF-8 text; 10 MiB; up to 5 per comment) in a private Supabase bucket.
- **Bulk status change** for up to 100 selected tickets, all-or-nothing, naming every refused ticket.
- **Customers, users, agents, groups, memberships and statuses** are administered in the same panel; the dashboard shows live counts.
- **Roles:** ADMIN sees and manages everything; AGENT sees and works only the tickets of their groups. The scope is applied in the services, so lists, counts, search, history and downloads all obey it, and an out-of-scope id answers 404.
- **Optimistic locking:** every edit carries the version it started from; a concurrent change is refused instead of overwritten.

## How it is built

| Part | Choice |
| --- | --- |
| Admin UI | AdminJS 7 with the light theme and custom React components (ticket header, inline comments, history, forms) |
| Server | Node 22, Express 4, TypeScript; one application and one container |
| Data | Prisma 6 on Supabase PostgreSQL (schema `support`); two database roles: the migrator (owns the schema, used only to migrate) and the runtime role (rows only, no DDL) |
| Files | Supabase Storage through its S3 API, private bucket, 60-second presigned downloads; nothing is written to the server's disk |
| Sessions | `express-session` in PostgreSQL, one login controller of our own |
| Delivery | GitHub Actions: CI on `develop`, the secret scan on `main`, then image, migrations and an SSH deployment with a health check and automatic rollback; Caddy terminates HTTPS |

The business rules live in domain services (`src/domain`) and policies (`src/policies`), not in AdminJS hooks. AdminJS resources are guarded wrappers that call them, and the generic edit and delete actions that could bypass the workflow are switched off. Field labels and help texts come from one catalog (`src/admin/field-catalog.ts`).

## Security

- **Passwords:** Argon2id with m = 19 456 KiB (19 MiB), t = 2, p = 1, the OWASP minimum. An unknown e-mail and a wrong password give the same error. The parameters are to be revisited against the production host's CPU (D-008).
- **Sessions:** server-side, in PostgreSQL; `HttpOnly`, `SameSite=Lax`, `Secure` in production; 30 minutes idle, 8 hours absolute. The user is reloaded from the database on every request, and a change of role, password or active state bumps `sessionVersion` and ends the sessions.
- **Sign-in with Google and GitHub (optional):** the authorization code flow with PKCE and a one-time `state`; the code is exchanged on the server, and the provider's secret never reaches the browser. A provider is on when its client id and secret are set (`GOOGLE_*`, `GITHUB_*`), and the sign-in page shows a button for each. It opens only an account that **already exists**: matched by the provider's *verified* e-mail address (at GitHub, the primary verified one), active, and with an active agent profile for an AGENT. Nothing is created and no role comes from the provider, so an outsider cannot become a user (D-026). The callback addresses to register are `<PUBLIC_URL>/auth/oauth/google/callback` and `<PUBLIC_URL>/auth/oauth/github/callback`.
- **CSRF:** a synchronizer token plus a mandatory `Origin` check on every unsafe method (D-007).
- **Login limits:** 20 attempts per IP and 5 failed attempts per account in 15 minutes (in memory, single replica).
- **Administration menu:** groups, agents, statuses and staff accounts are listed, shown and edited by an ADMIN only; an AGENT does not see the menu section at all and gets a refusal from the API. Only `search` stays open to staff, scoped to their own groups, because the ticket forms and filters need it to offer groups, agents and statuses.
- **Authorization at three levels:** the loaded active user, hidden resources and buttons, and checks of role and scope in every service call. A user cannot raise their own role or deactivate the last active admin.
- **Uploads:** a dedicated route with bounded memory buffers (at most 4 uploads at once); the type is decided from the bytes (extension, declared type and content must agree; SVG, HTML and archives are refused); a storage failure gives a generic 502, so provider text never reaches the user.
- **Headers and secrets:** baseline security headers on every route and no `X-Powered-By`. There is no CSP, because AdminJS renders inline scripts (documented in `src/http/security-headers.ts`). Application secrets live only in `/opt/ticket-tracker/.env` on the server, never in the repository; `gitleaks` scans the whole history on every push.

## Tested versions

Node 22, TypeScript 7.0.2, AdminJS 7.8.17, @adminjs/express 6.1.1, @adminjs/prisma 5.0.4, @adminjs/themes 1.0.1, Prisma 6.19.3, Express 4.21.2, Argon2 0.45, Zod 4, PostgreSQL 17. Pinned in `package-lock.json`; details and constraints in `docs/decisions.md` (D-002).

## Local development
```
npm install
npm run dev:db                      # local PostgreSQL on :15432 (no Docker needed)
# set DATABASE_URL / DIRECT_URL to postgresql://postgres:postgres@localhost:15432/tickets?schema=support
npx prisma migrate dev
npm run admin:create -- --email admin@example.test   # password: hidden prompt or ADMIN_PASSWORD env
npm run build        # the admin UI components are loaded from dist/ (run build:watch while editing them)
npm run dev
```

Copy `.env.example` to `.env` (git-ignored) first; `SESSION_SECRET` must be at least 32 characters.

## Tests
`npm test` runs unit and integration tests: 33 files, about 390 cases covering the workflow matrix, roles and scope, optimistic locking, comments, attachments and the reconcile job, bulk changes, authentication and CSRF, the security headers, the AI field help and the demo dataset. Integration tests need a database with migrations applied (`DATABASE_URL`, e.g. the `dev:db` instance); CI uses a Postgres service. Use a throwaway database: some tests briefly switch other active administrators off while they run. The suites for the workflow, attachments and bulk changes were mutation-checked (the guard under test was removed on purpose and the suite had to fail).

The `ci` workflow (pull requests to `develop` and pushes to `develop`) type-checks, tests, builds the production image, runs it against PostgreSQL and smoke-tests it with both roles. The smoke test (`smoke.js`) is for a test environment: CI runs it against a throwaway database, and it is run by hand against staging when needed.

## Out of scope and known limits
- **Not built:** Self-registration through OAuth (sign-in with Google or GitHub exists, but only for accounts an administrator already created, D-026); a customer portal or customer login; inbound e-mail; antivirus scanning of uploads; comment deletion (disabled by design); a background job for bulk changes of more than 100 tickets (use batches); monitoring and alerting; high availability (one server, a few seconds of unavailability while the container is replaced); a shared store for the login limits (needed once there is more than one replica).
- **AI field help (optional bonus, requirements section 12):** built, off by default, and tried against the real Claude API (`claude-haiku-5-5`, about 1.2 seconds for a short question); see "AI field help" below.
- **Customers are a shared directory** among staff, not a multi-tenant model: an agent can see the names and e-mail addresses of known customers but cannot reach out-of-scope tickets through them.
- **A direct push to `main` is deployed after the secret scan only**, without the tests (they ran on `develop`). Branch protection is planned for when the repository becomes public (`docs/acceptance.md`).

## AI field help (optional)

Off by default (`AI_ENABLED=false`): then there is no endpoint, no script and no cost. Switched on, a "?" button on every screen with fields opens a panel where a person picks a field of that screen and asks a question; the answer comes from Claude and is shown as plain text.

- **What the model sees:** only the field's label, help, type, required flag, validation and allowed values from the field catalog (`src/admin/field-catalog.ts`), and for status-related fields the statuses (WAITING_CUSTOMER, RESOLVED and UNRESOLVED are explained) and the transitions. It never receives a ticket, a customer, a person, a password hash or a secret, and it has no tools. The browser sends a screen id, a field id and the question; the server looks both ids up for the person's role and answers 404 for what the role cannot open (an agent gets help for Ticket and Customer fields, an administrator for all).
- **The question is data:** the instruction is fixed text, the question sits in its own block of the user message with angle brackets neutralised, and the instruction says to answer only from the context, to admit what it does not contain and to ignore instructions inside the question.
- **Limits:** 10 questions a minute per person (HTTP 429), a daily budget of 200 requests for everyone, a 10 second wait without retries, answers of about 120 words (hard-cut at 1200 characters). When the AI cannot answer (timeout, 429, 5xx, a refusal, the budget spent) the panel shows the field's static help and a note; the rest of the admin is unaffected.
- **Provider and model:** Claude through the official `@anthropic-ai/sdk`, `claude-opus-5-5` with low effort by default; `AI_MODEL=claude-haiku-5-5` is cheaper and faster.
- **Configuration** (`.env`): `AI_ENABLED=true` and `ANTHROPIC_API_KEY` switch it on (the application refuses to start with the flag and no key); optional `AI_MODEL`, `AI_EFFORT` (`low`, `medium`, `high`), `AI_RATE_PER_MINUTE`, `AI_TIMEOUT_MS`, `AI_MAX_OUTPUT_TOKENS`, `AI_DAILY_REQUESTS`. `AI_PROVIDER=fake` answers from the catalog without calling anyone, for development and tests (refused in production). On the server: put the two values in `/opt/ticket-tracker/.env` and restart the application.
- **Limitations:** the limits are counted in memory (one replica; a restart resets the day); answers can be wrong, and the panel says so; only English field descriptions exist, though the model answers in the language of the question; only `claude-haiku-5-5` was measured against the real API (about 1.2 seconds), not the default `claude-opus-5-5`. Details: D-025.

## Layout
See section 14 of the requirements. `src/` holds the app, `prisma/` the schema and migrations, `src/cli/` the seed, admin and storage commands (compiled into the image as `dist/cli/*.js`), `tests/` unit, integration and e2e suites.


### Commit messages

Commits follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/):
`<type>(<scope>): <summary>`. The summary is imperative, lowercase, has no trailing period and stays within about
72 characters. Each commit is one logical change, so the history shows how the project was built step by step.

| Type | Use for |
| --- | --- |
| `feat` | New user-visible behaviour (API endpoint, page, admin action) |
| `fix` | Bug fix |
| `build` | Build setup, dependencies, Dockerfiles, Compose |
| `ci` | GitHub Actions workflows |
| `test` | Tests only |
| `refactor` | Code change without behaviour change |
| `perf` | Performance improvement |
| `docs` | Documentation only |
| `chore` | Maintenance that fits no other type |

## Docker

```
docker build -t support-ticket-tracker .                                   # pinned Node, prepared AdminJS bundle, runs as `node`
docker compose up --build                                                  # the image with its own PostgreSQL (migrations run first)
docker run --rm --env-file prod.env IMAGE npx prisma migrate deploy        # migrations are a separate step (owner role)
docker run --rm -e ADMIN_PASSWORD=... --env-file prod.env IMAGE node dist/cli/admin-create.js --email admin@example.test
docker run --rm --env-file prod.env IMAGE node dist/cli/storage-reconcile.js --dry-run
docker run --rm -e SMOKE_BASE_URL=https://... -e SMOKE_ADMIN_EMAIL=... -e SMOKE_ADMIN_PASSWORD=... [-e SMOKE_AGENT_EMAIL=... -e SMOKE_AGENT_PASSWORD=...] IMAGE node dist/cli/smoke.js
```

The smoke test (`smoke.js`) is for a test environment: CI runs it against a throwaway database (with `--write`), and it is run by hand against staging when the project needs it. The production deployment does not run it (D-024); against production use it read only (without `--write`) with accounts created for the purpose.

The commands behind the npm scripts are compiled into the image as `dist/cli/*.js`. CI builds the image, runs it against PostgreSQL and smoke-tests it with both roles; `deploy` publishes it to GHCR and `storage-reconcile` runs nightly once enabled. Details: D-018.

## Production on Supabase

One-time setup (details and reasons: D-020). Passwords and keys live only in the host's secret store, in the GitHub environment `production` and in a git-ignored local file (for example `.env.production.local`); never in the repository or in chat.

1. **Supabase dashboard.** Create the private bucket `ticket-attachments`. Under *Settings > API > Exposed schemas* keep only `public` (the schema `support` must not be exposed). Under *Settings > Database* copy the **session pooler** connection string (port 5432) and download the **SSL certificate**.
2. **Database roles**, once, with the project owner's connection (generate two different passwords of 24+ characters and keep them):
   ```
   ADMIN_DATABASE_URL=postgresql://postgres:...@HOST:5432/postgres MIGRATOR_PASSWORD=... RUNTIME_PASSWORD=... npm run db:provision
   ```
   It creates `migrator` (owns the schema, migrations only) and `app_runtime` (rows only, no DDL), verifies the result and prints no password.
3. **Secrets.** In the GitHub environment `production`: `DIRECT_URL` (the migrator's URL), `DATABASE_URL` (the runtime role's URL, with `sslmode=require&connection_limit=5`), `S3_*` (bucket `ticket-attachments`), and the `VPS_*` secrets of the section below; variable `PRODUCTION_URL`. On the server (`/opt/ticket-tracker/.env`): `APP_ENV=production`, `PUBLIC_URL` (https), `TRUST_PROXY`, `SESSION_SECRET`, `DATABASE_URL`, `DATABASE_CA_CERT`, `S3_*`; never `DIRECT_URL`.
4. **Deliver.** A push to `main` that passes the secret scan runs `deploy`: image, migrations, the server update over SSH, storage check, wait for the address. The first administrator (once): `ADMIN_PASSWORD=... node dist/cli/admin-create.js --email ...` with the runtime role's `DATABASE_URL`.

## VPS

Delivery to a server of your own (D-022). Everything is in `deploy/vps/`. One-time setup:

1. **A server** with Ubuntu or Debian, a public IPv4 address and a DNS name that points at it (an `A` record; without a domain use `<ip with dashes>.sslip.io`). On your computer generate a key used only for deployments: `ssh-keygen -t ed25519 -f deploy_key -C deploy@github-actions`.
2. **Prepare it** (as root, once, safe to repeat): copy `deploy/vps/bootstrap.sh` to the server and run `sudo ./bootstrap.sh --ssh-key "$(cat deploy_key.pub)"`. It installs Docker, creates the `deploy` user, opens only SSH, 80 and 443 and turns on security updates. Check that `ssh -i deploy_key deploy@<address>` works, then run it again with `--harden-ssh`.
3. **The server's environment**: as the `deploy` user create `/opt/ticket-tracker/.env` from `deploy/vps/.env.example` (`chmod 600`): `DOMAIN`, `ACME_EMAIL`, `PUBLIC_URL`, a new `SESSION_SECRET`, `DATABASE_URL` (the runtime role through the session pooler), `DATABASE_CA_CERT`, `S3_*`. It stays on the server; the pipeline never touches it.
4. **GitHub**, environment `production`: secrets `VPS_HOST`, `VPS_USER` (`deploy`), `VPS_SSH_KEY` (the content of `deploy_key`), `VPS_HOST_KEY` (the output of `ssh-keyscan -t ed25519 <address>`), and the variable `PRODUCTION_URL` (`https://<DOMAIN>`).
5. **Deliver**: a push to `main` that passes the secret scan runs `deploy`: image, migrations, copy of `deploy/vps`, `deploy.sh` over SSH (pull, start, wait for healthy, roll back if not), then the storage check and the wait for the address.

**Operator scripts** (copied to `/opt/ticket-tracker/tools/` by every deployment, run on the server as `deploy`; D-023):

| Script | What it does |
| --- | --- |
| `./tools/admin-create.sh --email you@example.com [--name "..."]` | creates an administrator (the password is asked for, hidden) |
| `./tools/seed.sh [--tickets 2000] [--seed 42]` | creates the demo dataset; `--tickets 20000` or `--tickets 200_000` for more (customers, comments and files grow with it) |
| `./tools/verify.sh` | checks the dataset: counts, workflow, dates, every file in the bucket |
| `./tools/remove.sh [--dry-run]` | removes the demo dataset (only its own rows and files) |

Demo data in production needs a deliberate bypass: the scripts run each command once with `APP_ENV=demo`, only for that container, and ask you to type a phrase first. Plan for 1 GB of free memory per 50 000 tickets (the script checks). Details and limits: D-023.

By hand on the server: `/opt/ticket-tracker/deploy.sh ghcr.io/<owner>/<repo>:<sha>` redeploys a version (add `--registry-login-stdin` and pipe the user and a token on two lines for a private image); `docker compose logs -f app` shows the application's log.

## Demo data

```
SEED_ADMIN_PASSWORD=... SEED_AGENT_PASSWORD=... npm run seed:demo -- --seed 42   # 17 accounts, 300 customers, 2000 tickets, 10000 comments, 200 files
#   --tickets N (500 to 1000000) makes it bigger: customers, comments and files scale with it; give the same N to seed:verify and seed:reset
npm run seed:verify                                                              # counts, workflow, dates, and every file present in Storage
ALLOW_DEMO_RESET=true npm run seed:reset -- --dataset takehome-demo --confirm takehome-demo [--dry-run] [--delete-only]   # APP_ENV must be set (development or demo)
```

In VS Code the same steps are in **Run and Debug** ("Seed: ...", the passwords are asked for hidden and not stored; a reset asks you to type the dataset name) and in **Terminal > Run Task** ("seed: ...", and "demo: migrate, seed statuses and load the demo data" for a first-time setup).

Accounts are `admin1@example.test`, `admin2@example.test` and `agent01@example.test` ... `agent15@example.test`; the passwords are the two environment variables above (12+ characters, hashed, never printed). The files need the S3 settings of `.env` (the in-memory storage is refused). Reruns add nothing twice; `--rotate-demo-passwords` changes the passwords of existing demo accounts. Reset prints what it will remove, deletes only the demo rows and files and is refused in production (and whenever `APP_ENV` is not set explicitly to `development` or `demo`). Details and limits: D-017.

## Bulk status change

On the ticket list, tick up to 100 tickets and use **Bulk Change Status**. The form lists the selected tickets and offers only the changes that are valid for all of them. Everything is applied in one transaction: if any ticket is refused (changed by someone else, wrong status, not allowed for your role), nothing changes and the form names every refused ticket (`Ticket #123: ...`). For more than 100 tickets, work in batches.

Concurrent edits are handled with optimistic locking: the form remembers the version of every ticket it shows, and a ticket that somebody else saved in the meantime makes the whole batch fail instead of being overwritten. Reload the list and repeat. Details: D-016.

## Attachments and storage
Files are stored in a **private** Supabase Storage bucket `ticket-attachments` through its S3-compatible API; they never touch the server's disk. Set `S3_ENDPOINT` (`https://<project-ref>.supabase.co/storage/v1/s3`), `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and `S3_BUCKET` (all four S3 variables are required in production and demo). Without them, development keeps files in memory and loses them on restart.

- `npm run storage:check`: writes, reads back, signs and deletes a small object; prints no secrets.
- `npm run storage:reconcile -- --dry-run`: reports what is out of line between the database and the bucket after crashes (stale PENDING/FAILED/DELETING rows, objects without a row, rows without an object); without `--dry-run` it fixes them. Schedule it (a GitHub Actions cron is planned for the deployment stage).
- Limits: one file per upload, 10 MiB, 5 files per comment; PNG, JPEG, PDF and UTF-8 text.

## License

MIT, see `LICENSE`.
