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