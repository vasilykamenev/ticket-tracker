# Decisions

Source of truth: `Support_Ticket_Tracker_Requirements_EN_v1.1.md`.

## D-001 Naming and the `com.berney` domain
The stack is TypeScript/Node.js (no JVM packages). `com.berney` is the organisation identifier and is applied to:
- npm scope: `@berney/support-ticket-tracker`
- OCI image vendor label and GHCR namespace `ghcr.io/berney/...`
- (if Java-style package folders are wanted later, move code under `src/com/berney/...`; not done by default)

## D-002 Pinned versions (stage 1, verified 2026-10-10)
Node 22.23, TypeScript 7.0.2, `adminjs` 7.8.17, `@adminjs/express` 6.1.1, `@adminjs/prisma` 5.0.4,
`prisma` / `@prisma/client` 6.19.3, `express` 4.21.2, `express-session` 1.18.1, PostgreSQL 17.

- **Prisma stays on 6.x.** `@adminjs/prisma@5.0.4` declares peer `@prisma/client ^5 || ^6`; Prisma 7/8 are not supported. Do not upgrade Prisma until the adapter does.
- **Express stays on 4.x.** The AdminJS plugin does not declare Express 5 support.
- `multiSchema` is GA in Prisma 6; no preview flag.

## D-003 Every referenced model must be registered in AdminJS
`list`/`show` of Ticket fail with "no resources with given id" unless User, Agent, Customer, SupportGroup, TicketStatus are registered. Register all, then hide/restrict via `isVisible`, `navigation: false` and action `isAccessible` (stages 3-6). Registration is not exposure.

## D-004 Local development database
No Docker on the dev machine, so `npm run dev:db` starts PostgreSQL via `embedded-postgres` (beta tag, dev-only, port 15432, UTF8, data in `.devdb/`). Port 54329 is in a Windows reserved range; avoid 54198-54397.

## D-005 AdminJS bundling at startup
In production AdminJS bundles custom components into `.adminjs/` on startup (~30-60 s here). The container's runtime user needs write access to it. Healthcheck/readiness must tolerate the delay.

## D-006 One session, own login controller (stage 3)
`@adminjs/express` `buildRouter` reads `req.session.adminUser` as `currentAdmin`, so the app uses its own `express-session` + `connect-pg-simple` (table `support."Session"`, owned by Prisma) and `buildRouter`, not `buildAuthenticatedRouter` (which would create a second session). `requireUser` reloads the user from the DB on every request and checks `isActive`, an active Agent profile for AGENT, `sessionVersion`, and the 8 h absolute lifetime; idle timeout (30 min) is the sliding cookie/store expiry (`rolling`).

Middleware order (matters): health -> session -> `/auth` form parser (4 KiB) -> CSRF -> `/auth` routes -> `requireUser` -> AdminJS router. `buildRouter` brings `express-formidable`, which writes uploads to disk, so CSRF must run before it and uploads (stage 8) need their own route mounted before the AdminJS router.

## D-007 CSRF
Synchronizer token in the session + mandatory `Origin` check (missing Origin is rejected on unsafe methods). Token is read from `X-CSRF-Token` or a parsed `_csrf` form field. The AdminJS client gets the header from `public/csrf-client.js` (patches XHR and fetch, same-origin only, token from `GET /auth/csrf`). Logout is POST; the link AdminJS renders (GET) shows a confirmation form.

## D-008 Known limitations
- Login rate limits are in-memory: correct for a single replica only; multiple replicas need a shared store.
- Argon2id parameters: m=19456 KiB, t=2, p=1 (OWASP minimum); revisit against the production host's CPU.
- The model/resource exposure in AdminJS is still unrestricted for any signed-in user; RBAC is stages 4-6.

## D-009 Domain services and policies (stage 4)
- `TicketService` (create, update, assign, changeStatus, get), `GroupService`, `AgentService` take an `Actor` (`userId`, `role`, `agentId`) and load the group scope inside their own transaction. Callers (AdminJS actions, stage 5) must go through them; standard AdminJS new/edit/delete must be disabled or replaced.
- Every write is one transaction: ticket change + `version` increment + `TicketHistory` row. Concurrent writers are serialized by `UPDATE ... WHERE id AND version`; the loser gets `version_conflict` (409).
- Out-of-scope and unknown ids give 404 (`not_found`); in-scope but insufficient role gives 403 (`admin_only`, `group_not_allowed`).
- Row locks (`FOR SHARE` on assign, `FOR UPDATE` on deactivate/remove-member, always group before agent) prevent an active ticket ending up on an inactive agent when assignment and deactivation race. Covered by a repeated race test.
- `changeStatusInTx` is the unit reused by the all-or-nothing bulk action (stage 9).
- Reopening takes an optional `groupId`/`assignedAgentId` in the same call, so the transition and the new assignee are atomic.

### Interpretations of the requirements (confirm or change)
- Ordinary edit covers subject, description and priority (the matrix says "description/priority"; subject added so typos can be fixed).
- On a group change the assignee is never cleared implicitly: keeping an assignee who is not in the new group fails; to unassign (NEW only) pass `assignedAgentId: null`.
- Changing status requires being in the ticket's group scope, not being its assignee.
- "Active assignee" for NEW/WAITING -> IN_PROGRESS, UNRESOLVED and every reopening means: active agent, member of the active group. WAITING_CUSTOMER and RESOLVED only require an assignee to be set; CLOSED requires none.
- An agent whose *User* is deactivated is not rejected as an assignee yet (User deactivation must also deactivate the Agent; stage 6).
