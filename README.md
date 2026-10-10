# Support Ticket Tracker (com.berney)

Internal support-staff application: AdminJS + Express + Prisma on Supabase PostgreSQL and Storage.

Status: project skeleton only. Requirements: `docs/Support_Ticket_Tracker_Requirements_EN_v1.1.md`. Decisions: `docs/decisions.md`. Progress: `docs/acceptance.md`.

## Next step
Stage 1: choose and pin a compatible set of AdminJS / `@adminjs/express` / `@adminjs/prisma` / Prisma / Node, then `npm install` and record the tested versions here.

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