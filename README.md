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
See section 14 of the requirements. `src/` holds the app, `prisma/` the schema and migrations, `scripts/` the seed/admin/storage commands, `tests/` unit, integration and e2e suites.


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
## Attachments and storage
Files are stored in a **private** Supabase Storage bucket `ticket-attachments` through its S3-compatible API; they never touch the server's disk. Set `S3_ENDPOINT` (`https://<project-ref>.supabase.co/storage/v1/s3`), `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and `S3_BUCKET` (all four S3 variables are required in production and demo). Without them, development keeps files in memory and loses them on restart.

- `npm run storage:check`: writes, reads back, signs and deletes a small object; prints no secrets.
- `npm run storage:reconcile -- --dry-run`: reports what is out of line between the database and the bucket after crashes (stale PENDING/FAILED/DELETING rows, objects without a row, rows without an object); without `--dry-run` it fixes them. Schedule it (a GitHub Actions cron is planned for the deployment stage).
- Limits: one file per upload, 5 MiB, 5 files per comment; PNG, JPEG, PDF and UTF-8 text.
