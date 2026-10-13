# Tests

The tests are run by [Vitest](https://vitest.dev). Test names are written as sentences about a rule, so the
list of names in the CI report reads as a specification.

| Folder | Needs a database | What it covers |
| --- | --- | --- |
| `unit/` | no | Pure logic: workflow, policies, validation, configuration, the AI help |
| `integration/` | yes (`DATABASE_URL`) | Domain services against PostgreSQL, and the HTTP API through the real Express app |

## Running

```bash
npm test                              # everything (integration tests need DATABASE_URL, see .env.example)
npx vitest run tests/unit             # unit tests only, no database
npx vitest run tests/integration/auth.test.ts
```

Integration tests share one database, so files run one after another (`fileParallelism: false`).

## In CI

The `verify` job in `.github/workflows/ci.yml` runs the tests against a PostgreSQL service. Failures appear as
annotations on the pull request, and the **Tests** check lists every file and case with its time. The JUnit file is
written to `test-results/junit.xml`.

## Unit tests (`tests/unit`)

| File | What it checks |
| --- | --- |
| `workflow.test.ts` | The transition matrix (exactly the listed transitions), ADMIN-only steps, required reasons and outcomes, input schemas |
| `comment-policy.test.ts` | Who may add and edit a comment in which status; unknown statuses fail closed |
| `age.test.ts` | Ticket age: runs while active, stops at the end of work, never negative, formatting |
| `auth.test.ts` | Argon2id password hashing, e-mail normalisation, environment loading and defaults |
| `security-headers.test.ts` | No sniffing or framing, referrer limits, HSTS only in production |
| `discard-body.test.ts` | Refused requests (CSRF, unauthenticated, oversized) discard the unread body |
| `file-validation.test.ts` | Attachments: type from the bytes, 10 MiB limit, empty files, file-name sanitising |
| `storage.test.ts` | Content-Disposition safety, in-memory storage, S3 storage behaviour |
| `session-pool-config.test.ts` | Database URL handling for the session pool, CA verification |
| `seed-dataset.test.ts` | The demo dataset: volumes, example.test addresses, consistency, reproducibility |
| `seed-scale.test.ts` | Dataset size option (2000 tickets), supported range |
| `assistant-context.test.ts` | AI help: field and status context, screens by role, nothing invented |
| `assistant-limits.test.ts` | AI help: per-minute and daily limits, per user |
| `assistant-provider.test.ts` | AI help: one bounded request, timeout, configuration errors, fake provider |
| `assistant-service.test.ts` | AI help: fixed instruction, no ticket or personal data sent, refusals without calling the provider |

## Integration tests (`tests/integration`)

| File | What it checks |
| --- | --- |
| `ticket-service.test.ts` | Create, update, scope by group, optimistic locking, fields the client must not set |
| `ticket-queries.test.ts` | Form state, allowed transitions, assignee choices, history, customer tickets |
| `bulk-status.test.ts` | Bulk status change service: all or nothing, history per ticket, 100-ticket limit |
| `comment-service.test.ts` | Adding and editing comments, rules by role and status, one comment belongs to one ticket |
| `attachment-service.test.ts` | Upload states (PENDING to READY), storage failures, downloads, access rights |
| `staff-services.test.ts` | Accounts: creation, editing, passwords, roles, ADMIN-only |
| `group-status-services.test.ts` | Groups, members and statuses: codes, deactivation, deactivated status in the workflow |
| `admin-resources.test.ts` | Ticket and Customer screens: scope, filters, sorting, paging, writes through services, menu by role |
| `admin-actions.test.ts` | Change status and assign actions over HTTP: statuses, field errors, CSRF |
| `admin-bulk.test.ts` | Bulk status change over HTTP: valid changes for all selected, hidden tickets, CSRF |
| `admin-comments.test.ts` | Inline comments over HTTP: author, paging, scope, editing |
| `admin-attachments.test.ts` | Uploads and downloads over HTTP: multipart, Cyrillic names, CSRF, logging |
| `admin-staff.test.ts` | Staff screens: accounts, signing people out, groups, closed to AGENTs |
| `auth.test.ts` | Health check, security headers, root redirect, sign-in and CSRF, session revocation, rate limits |
| `oauth.test.ts` | Google and GitHub sign-in: configuration, state and PKCE, callback |
| `assistant-routes.test.ts` | AI help endpoints: off by default, on when configured, auth and CSRF |
| `db-roles.test.ts` | Database roles and schema setup: least privilege, repeatable, validation |
| `storage-reconcile.test.ts` | `storage:reconcile`: stale uploads, failed rows, interrupted deletions |
| `seed-demo.test.ts` | `seed:demo`, `seed:verify`, `seed:reset`: whole dataset, repeat runs, passwords |

Requirements are mapped to tests in [docs/acceptance.md](../docs/acceptance.md).
