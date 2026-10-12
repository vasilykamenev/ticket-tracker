# Deployment and operations

How the application is built, delivered and run, and how to operate it. Related: [architecture](architecture.md),
[database](database.md), [decisions](decisions.md) (D-018, D-020, D-022, D-023, D-024).

## From a change to production

```mermaid
flowchart LR
    DEV["Feature branch"] -->|"pull request"| CI
    subgraph CI["ci: pull request or push to develop"]
        V["verify<br/>type-check, tests"]
        D["docker<br/>build the image, run it on PostgreSQL,<br/>smoke test with both roles"]
    end
    CI -->|"merge"| DV[("develop")]
    DV -->|"pull request"| G1["gitleaks<br/>scan the full history"]
    G1 -->|"merge by the owner"| MN[("main")]
    MN -->|"push"| G2["secrets-scan"]
    G2 -->|"succeeded"| DEP

    subgraph DEP["deploy"]
        direction TB
        I["image<br/>build, push to GHCR (:sha, :latest)"] --> M["migrate<br/>prisma migrate deploy<br/>(migrator role) + seed:reference"]
        M --> S["deploy<br/>copy deploy/vps, ssh, deploy.sh:<br/>pull, start, wait for healthy,<br/>roll back if not"]
        S --> VF["verify<br/>object storage check,<br/>wait for /health/ready"]
    end
```

- **`develop` is where tests run.** The `ci` workflow runs on pull requests to `develop` and on pushes to it. `main` is protected:
  pull requests only, with the checks `verify`, `docker` and `gitleaks`, and the rules apply to administrators too.
- **A push to `main` deploys after the secret scan, not after the tests** (D-024). Everything reaches `main` through a pull
  request from `develop`, so the code was tested there. The checks on a pull request belong to its head commit, so the
  `develop` to `main` request shows the results that ran on `develop`.
- **The deploy job group uses the `production` GitHub environment** (its secrets; reviewers can be required there). Only one
  deployment runs at a time, and a newer one waits instead of cancelling a running migration.
- **Migrations run before the new container starts**, with the migrator role from GitHub's runner through Supabase's session
  pooler. The application never holds migration credentials. A migration that fails stops the deployment before anything on
  the server changes.
- **`deploy.sh` makes a bad release harmless:** it pulls the image first (a failed pull changes nothing), starts the new
  version, waits up to `DEPLOY_WAIT_SECONDS` (120) for the container to be healthy, records the image in `.deployed-image`,
  and otherwise starts the previous image again and fails the deployment.
- **After the deployment** `verify` checks object storage and waits for `/health/ready` at `PRODUCTION_URL`. There is no smoke
  test against production (it needs accounts of both roles); it runs in `ci` against a throwaway database and can be run
  by hand.
- **Nightly** (`storage-reconcile`, 03:17 UTC, once `RECONCILE_ENABLED=true`): finds files and rows that disagree after crashes
  and fixes them. A manual run is a dry run unless it says otherwise.

## The production server

```mermaid
flowchart TB
    U["Browser"] -->|"443 / 80"| host
    subgraph host["VPS (Ubuntu or Debian), /opt/ticket-tracker"]
        direction TB
        C["caddy:2<br/>HTTPS, redirects 80 to 443"]
        A["app (the image)<br/>read-only filesystem, no capabilities,<br/>768 MB, 256 processes, port 3000 private"]
        T["tools (profile, on demand)<br/>operator scripts"]
        C -->|"internal network"| A
        E[".env (chmod 600)<br/>the application's secrets"]
        E -.-> A
        E -.-> T
    end
    A --> PG[("Supabase PostgreSQL<br/>session pooler, runtime role, TLS with the pinned CA")]
    A --> ST[("Supabase Storage<br/>private bucket ticket-attachments")]
```

Only SSH, 80 and 443 are open (`bootstrap.sh` sets this up, turns on automatic security updates, and can disable password
SSH). The application container writes nothing to disk: files go to Storage, sessions to PostgreSQL, logs to Docker's
rotated JSON files (10 MB, 5 files).

## Configuration reference

The whole configuration is read once at start-up (`src/config/env.ts`); an invalid value stops the application with the
variable's name and the reason, never its value. In production the secrets live only in `/opt/ticket-tracker/.env` on the
server, in the GitHub environment `production`, and in a git-ignored local file.

| Variable | Default | Meaning |
| --- | --- | --- |
| `APP_ENV` | `development` | `development` (dev server, in-memory files allowed), `test`, `demo` (deployed, plain HTTP allowed, demo tools allowed), `production` (HTTPS required, `Secure` cookies, HSTS, demo tools refused) |
| `PORT` | 3000 | Listening port inside the container |
| `PUBLIC_URL` | required | The address people use; its origin is what CSRF accepts and what OAuth callbacks are built from; `https` in production |
| `TRUST_PROXY` | 0 | Number of reverse proxies in front (1 behind Caddy); set to the real count only |
| `DATABASE_URL` | required | The runtime role's connection (the application) |
| `DIRECT_URL` | | The migrator's connection; migrations only, never on the server |
| `DATABASE_CA_CERT` | | PEM text of the CA that signed the database's certificate (Supabase) |
| `SESSION_SECRET` | required | 32 characters or more; never a placeholder in production |
| `SESSION_IDLE_MINUTES`, `SESSION_ABSOLUTE_HOURS` | 30, 8 | Session lifetime |
| `LOGIN_WINDOW_MINUTES`, `LOGIN_MAX_PER_IP`, `LOGIN_MAX_FAILED_PER_ACCOUNT` | 15, 20, 5 | Sign-in limits |
| `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET` | bucket `ticket-attachments` | Object storage; all four of the first group or none, and required in `production` and `demo` |
| `MAX_CONCURRENT_UPLOADS` | 4 | Uploads handled at once (each holds up to 10 MiB in memory) |
| `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET` | | Optional sign-in; a provider needs both of its values |
| `AI_ENABLED`, `ANTHROPIC_API_KEY`, `AI_MODEL`, `AI_EFFORT`, `AI_RATE_PER_MINUTE`, `AI_TIMEOUT_MS`, `AI_MAX_OUTPUT_TOKENS`, `AI_DAILY_REQUESTS`, `AI_PROVIDER` | off | Optional AI field help (see the README) |
| `DOMAIN`, `ACME_EMAIL` | | Used by Caddy only (`compose.yaml`), in the server's `.env` |
| `ALLOW_DEMO_RESET` | | Allows `seed:reset`; never in production |

## Health and logs

- `GET /health/live`: the process answers. Caddy and the container health check use it.
- `GET /health/ready`: the database answers (`SELECT 1`); 503 otherwise. Neither creates a session or leaks configuration.
- Logs: `docker compose logs -f app` on the server. Error handling logs only the error's type and code, never submitted
  data, a key or a provider's text.

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

## Troubleshooting

| Symptom | Likely cause and what to do |
| --- | --- |
| The `migrate` job fails with *"type ... already exists"* or *"relation ... already exists"* | The database and Prisma's record (`support._prisma_migrations`) disagree, usually because tables were created or cleaned by hand. Inspect what exists, then either remove the leftovers and the failed record, or mark the migration applied with `prisma migrate resolve --applied <name>` under the migrator role. See *Migrations* in [database](database.md). Never reset or `db push` production. |
| The `migrate` job fails with *"The production environment has no DIRECT_URL secret"* | Create the roles with `db:provision` and add the migrator's URL as the `DIRECT_URL` secret of the `production` environment. |
| `deploy` fails and says it rolled back | The new image did not become healthy in time. The previous version is running. Read `docker compose logs app` on the server: usually an invalid or missing variable (the log names it, never its value) or a database it cannot reach. |
| The site answers 502 or 503 right after a deployment | The new container is still starting; Caddy waits up to 15 seconds for it. If it persists, check `docker compose ps` and the log. |
| `/health/ready` is 503 | The application cannot reach PostgreSQL: check `DATABASE_URL`, `DATABASE_CA_CERT`, and that the runtime role's password was not rotated. |
| Sign-in answers "forbidden" on the first try after a restart | The browser holds a CSRF token from the old session. Try again. |
| A person cannot sign in with Google or GitHub | The address at the provider must match an existing, active account's e-mail and be verified there; an AGENT also needs an active profile. The message is deliberately the same for every reason. |
| Uploads fail with 502 | Storage is unreachable or the keys are wrong. `npm run storage:check` (or the same command in the image) writes, reads, signs and deletes a small object and prints no secrets. |

## Backups and limits

- **Data** lives in Supabase. This repository configures no backup of its own: rely on the project's automatic backups
  according to its plan, and test a restore before depending on it. Files are in the bucket and the database rows that point
  at them are in PostgreSQL; `storage:reconcile` reports when the two disagree.
- **Migrations are applied before the new container starts**, so a rollback of the container leaves the database migrated.
  A migration must therefore keep working with the previous version of the application (add a column before using it, drop
  one only after nothing reads it).
- **One server, one replica.** A deployment replaces the container in a few seconds. The sign-in and AI limits are counted in
  memory, so they hold for one replica and reset on restart (D-008).
