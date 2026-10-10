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
npm run dev
```

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