# Notes for the review

Where to look, what to click, and the likely questions with short answers. Credentials are not in this repository: reviewer accounts are shared separately.

## Access

- **Live:** https://3130058.vpsnet.cloud (HTTPS, certificate from Let's Encrypt through Caddy). Sign in at `/admin`.
- **Demo data** (loaded on the server with `./tools/seed.sh`, D-023): 17 accounts (2 admins `admin1@example.test`, `admin2@example.test`; 15 agents `agent01@example.test` ... `agent15@example.test`), 300 customers, 2000 tickets, 10 000 comments and 200 files, all on the `example.test` domain. The passwords are the two values the owner chose when loading the data and are handed over separately.
- **Code:** the GitHub repository (branches: `develop` is tested by CI, `main` is what runs in production). Progress and evidence: `docs/acceptance.md`; every non-obvious choice: `docs/decisions.md`.

## A ten-minute walk through the live system

1. **Sign in as an agent** (`agent01`). The dashboard shows live counts (my tickets, unassigned, waiting for customer, unresolved, all tickets I can see). Open the Ticket list: search, filters, sorting and pagination work on 2000 tickets; the agent sees only the tickets of their groups.
2. **Scope.** Take the id of a ticket from another group (as admin, or from the seed) and open it as the agent: the answer is 404, the same as for a record that does not exist.
3. **A ticket page.** The header line carries the number, status and priority; below are the fields, the history and the comments. Edit uses the same order, with the comments and the box for a new one just above Save.
4. **Comments and files.** Add a comment, attach a PNG, a PDF and a text file (up to 5 per comment, 10 MiB each), download one (a 60-second link, `Content-Disposition: attachment`), remove one. An SVG or a renamed executable is refused.
5. **Workflow.** Use **Change status** (or the Status field of the edit form, which makes the change together with the other edits, D-027): only the transitions of the matrix are offered; moving to RESOLVED asks for a resolution (at least 10 characters), to UNRESOLVED for a reason, back from RESOLVED for a reopening reason. An agent cannot close a ticket (RESOLVED to CLOSED is ADMIN-only).
6. **Bulk change.** Tick several tickets in the list, choose **Bulk Change Status**: the form lists them and offers only changes valid for all. Include one ticket the change does not suit: nothing is applied and the form names the refused ticket (`Ticket #123: ...`).
7. **Optimistic locking.** Open the same ticket in two tabs, change the priority in the first and save, then save a change in the second: the second is refused because it started from an old version.
8. **Sign in as an admin** (`admin1`). Users, agents, groups, memberships and statuses are administered here. Try to deactivate the only active admin, or to set your own role: both are refused. A change of a user's role, password or active state ends that user's sessions.
9. **History.** Every ticket keeps who did what and when, including the reason of each status change.

## Evidence for the main requirements

| Requirement | Where it is shown |
| --- | --- |
| Data model, migrations, indexes | `prisma/schema.prisma`, `prisma/migrations`; D-009, D-012 |
| Workflow and its transitions | `src/domain/tickets/workflow.ts`; `tests/unit/workflow.test.ts`, `tests/integration/ticket-service.test.ts` |
| Roles and scope on every read and write | `src/policies`, `src/domain`; `tests/integration/ticket-queries.test.ts`, `admin-resources.test.ts`; D-010 |
| No bypass through generic AdminJS actions | `src/admin/guarded-resource.ts`, `NO_ACTIONS`; `tests/integration/admin-actions.test.ts` |
| Optimistic locking | `version` on every ticket; `ticket-service.test.ts`, `bulk-status.test.ts` (mutation-checked) |
| Authentication, sessions, CSRF, limits | `src/auth`; `tests/integration/auth.test.ts`; D-006, D-007, D-008 |
| Inline comments | `src/admin/components/CommentsInline.tsx`; `comment-service.test.ts`, `admin-comments.test.ts`; D-014 |
| Attachments, private bucket, reconcile | `src/storage`, `src/domain/attachments`; `attachment-service.test.ts`, `storage-reconcile.test.ts`; D-015; checked against the real bucket on 2026-10-12 |
| Custom action `bulkChangeStatus` | `tests/integration/bulk-status.test.ts`, `admin-bulk.test.ts`; D-016 |
| Reproducible seed, reset and verify | `src/seed`, `seed:demo`, `seed:verify`, `seed:reset`; D-017, D-023 |
| Production image, CI, HTTPS, health check, rollback | `Dockerfile`, `.github/workflows`, `deploy/vps`; D-018, D-020, D-022, D-024; every deployment is logged in GitHub Actions |
| Secrets out of the repository | `.env` on the server only; `gitleaks` on every push |

## Likely questions

**Why AdminJS, and where is the authorization if AdminJS can hide things?** AdminJS builds the screens, but hiding a button is not authorization. Every read and write goes through a domain service that checks the loaded user's role and scope, so a hand-made request to `/admin/api` gets the same answer as the UI. The AdminJS resources are guarded wrappers around those services, and the generic edit and delete actions are switched off.

**How are lost updates prevented?** Each ticket has a `version`. A form and a bulk request carry the version they started from, and the update is conditional on it; a mismatch is refused and nothing is overwritten. Bulk changes lock the tickets in ascending order inside one transaction, so two batches cannot deadlock.

**What if the upload fails halfway?** An attachment row is reserved as PENDING (under the ticket and comment locks), the bytes go to the bucket, and only then the row becomes READY. A failure leaves FAILED and a best-effort delete; `storage:reconcile` (the `storage-reconcile` workflow: nightly once `RECONCILE_ENABLED` is set, and by hand with a dry-run option) finishes stale PENDING, FAILED and DELETING rows and removes objects without a row. Uploads use bounded memory buffers, and nothing touches the server's disk.

**Why a VPS and Caddy rather than a platform?** The owner chose to run the container on their own server (D-022, which replaced a Render setup, D-021). Caddy gets and renews the certificate itself; the deployment script pulls the verified image, waits for the container to be healthy and rolls back to the previous image if it is not.

**Why no Content-Security-Policy?** AdminJS renders with inline scripts and styles, so a strict CSP would break it. The other baseline headers are set and tested; the trade-off is written in `src/http/security-headers.ts`.

**What does not scale?** The login limits are counted in memory, which is right for one replica only. Sessions are already in PostgreSQL, so a second replica would need only a shared store for the limits.

**How are the demo data made safe?** The generator is deterministic (a seed and fixed ids), every record can be recognised by its id, and reset deletes exactly the dataset's own rows and files. It refuses production; on the live demo it is run once with an explicit override and a typed confirmation (D-023).

**Was an AI assistant used to write the code?** Yes, an AI coding assistant helped; the requirements ask that business rules, permissions and secret-field exclusion remain explicit reviewed code (section 8.2). They are code in `src/domain` and `src/policies`, covered by tests that were mutation-checked: the guard under test was removed on purpose and the suite had to fail.

**What does the AI help get to see, and what stops it from inventing things?** Only the field catalog entry of the field asked about (label, help, type, required, validation, allowed values, and for status fields the statuses and transitions); never a ticket, customer or secret, and it has no tools. The instruction is fixed text, the question is confined to its own block, and the instruction says to answer only from that context and to admit what it does not contain. When the AI is down, slow, rate limited or refuses, the panel shows the field's static help instead, so the feature can fail without hurting the admin (D-025).

**What is not done?** See "Out of scope and known limits" in the README: self-registration through OAuth (sign-in with Google or GitHub exists for accounts an administrator created, D-026), a customer portal, inbound e-mail, antivirus for uploads, monitoring, high availability. The optional AI field help is built (off unless `AI_ENABLED=true`) and was tried against the real API with `claude-haiku-5-5`.

## What I would do next

1. Compare the models for the AI field help by quality and cost on a set of questions (only Haiku 5.5 was tried, about 1.2 seconds), and decide the default.
2. A shared store for the login limits, and protection of `main` once the repository is public.
3. Monitoring and alerting, and a staging environment on which the smoke test with both roles runs after every deployment.
