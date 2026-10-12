# Support Ticket Tracker (com.berney)

Internal support-staff application: AdminJS + Express + Prisma on Supabase PostgreSQL and Storage.

Status: project skeleton only. Requirements: `docs/Support_Ticket_Tracker_Requirements_EN_v1.1.md`. Decisions: `docs/decisions.md`. Progress: `docs/acceptance.md`.

## Tested versions (stage 1)
Node 22, TypeScript 7.0.2, AdminJS 7.8.17, @adminjs/express 6.1.1, @adminjs/prisma 5.0.4, Prisma 6.19.3, Express 4.21.2, PostgreSQL 17. Details and constraints: `docs/decisions.md`.

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
`npm test` runs unit and integration tests. Integration tests need a database with migrations applied (`DATABASE_URL`, e.g. the `dev:db` instance); CI uses a Postgres service. Use a throwaway database: some tests briefly switch other active administrators off (and always restore them).

## Authentication
Local staff accounts, Argon2id hashes, PostgreSQL sessions, CSRF token + Origin check, login rate limits per IP and per account (in-memory, single replica). See `docs/decisions.md` D-006..D-008.

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

The commands behind the npm scripts are compiled into the image as `dist/cli/*.js`. CI builds the image, runs it against PostgreSQL and smoke-tests it with both roles; `deploy` publishes it to GHCR and `storage-reconcile` runs nightly once enabled. Details: D-018.

## Production on Supabase

One-time setup (details and reasons: D-020). Passwords and keys live only in the host's secret store, in the GitHub environment `production` and in a git-ignored local file (for example `.env.production.local`); never in the repository or in chat.

1. **Supabase dashboard.** Create the private bucket `ticket-attachments`. Under *Settings > API > Exposed schemas* keep only `public` (the schema `support` must not be exposed). Under *Settings > Database* copy the **session pooler** connection string (port 5432) and download the **SSL certificate**.
2. **Database roles**, once, with the project owner's connection (generate two different passwords of 24+ characters and keep them):
   ```
   ADMIN_DATABASE_URL=postgresql://postgres:...@HOST:5432/postgres MIGRATOR_PASSWORD=... RUNTIME_PASSWORD=... npm run db:provision
   ```
   It creates `migrator` (owns the schema, migrations only) and `app_runtime` (rows only, no DDL), verifies the result and prints no password.
3. **Secrets.** In the GitHub environment `production`: `DIRECT_URL` (the migrator's URL), `DATABASE_URL` (the runtime role's URL, with `sslmode=require&connection_limit=5`), `S3_*` (bucket `ticket-attachments`), `SMOKE_ADMIN_EMAIL`, `SMOKE_ADMIN_PASSWORD`, optionally `SMOKE_AGENT_*`, and the `VPS_*` secrets of the section below; variable `PRODUCTION_URL`. On the server (`/opt/ticket-tracker/.env`): `APP_ENV=production`, `PUBLIC_URL` (https), `TRUST_PROXY`, `SESSION_SECRET`, `DATABASE_URL`, `DATABASE_CA_CERT`, `S3_*`; never `DIRECT_URL`.
4. **Deliver.** A push to `main` that passes CI runs `deploy`: image, migrations, the server update over SSH, storage check, smoke test. The first administrator (once): `ADMIN_PASSWORD=... node dist/cli/admin-create.js --email ...` with the runtime role's `DATABASE_URL`.

## VPS

Delivery to a server of your own (D-022). Everything is in `deploy/vps/`. One-time setup:

1. **A server** with Ubuntu or Debian, a public IPv4 address and a DNS name that points at it (an `A` record; without a domain use `<ip with dashes>.sslip.io`). On your computer generate a key used only for deployments: `ssh-keygen -t ed25519 -f deploy_key -C deploy@github-actions`.
2. **Prepare it** (as root, once, safe to repeat): copy `deploy/vps/bootstrap.sh` to the server and run `sudo ./bootstrap.sh --ssh-key "$(cat deploy_key.pub)"`. It installs Docker, creates the `deploy` user, opens only SSH, 80 and 443 and turns on security updates. Check that `ssh -i deploy_key deploy@<address>` works, then run it again with `--harden-ssh`.
3. **The server's environment**: as the `deploy` user create `/opt/ticket-tracker/.env` from `deploy/vps/.env.example` (`chmod 600`): `DOMAIN`, `ACME_EMAIL`, `PUBLIC_URL`, a new `SESSION_SECRET`, `DATABASE_URL` (the runtime role through the session pooler), `DATABASE_CA_CERT`, `S3_*`. It stays on the server; the pipeline never touches it.
4. **GitHub**, environment `production`: secrets `VPS_HOST`, `VPS_USER` (`deploy`), `VPS_SSH_KEY` (the content of `deploy_key`), `VPS_HOST_KEY` (the output of `ssh-keyscan -t ed25519 <address>`), and the variable `PRODUCTION_URL` (`https://<DOMAIN>`).
5. **Deliver**: a push to `main` that passes CI runs `deploy`: image, migrations, copy of `deploy/vps`, `deploy.sh` over SSH (pull, start, wait for healthy, roll back if not), then the storage check and the smoke test.

By hand on the server: `/opt/ticket-tracker/deploy.sh ghcr.io/<owner>/<repo>:<sha>` redeploys a version (add `--registry-login-stdin` and pipe the user and a token on two lines for a private image); `docker compose logs -f app` shows the application's log.

## Demo data

```
SEED_ADMIN_PASSWORD=... SEED_AGENT_PASSWORD=... npm run seed:demo -- --seed 42   # 17 accounts, 300 customers, 2000 tickets, 10000 comments, 200 files
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
