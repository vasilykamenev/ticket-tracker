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
No Docker on the dev machine, so `npm run dev:db` starts PostgreSQL via `embedded-postgres` (beta tag, dev-only, port 15432, UTF8 with ICU locale `en-US`, data in `.devdb/`). The ICU locale matters: with locale `C`, `ILIKE` is not case-insensitive for Cyrillic. If `.devdb/` was created earlier with `--locale=C`, delete it and run `npm run dev:db`, then `npx prisma migrate deploy` and `npm run seed:reference`. Port 54329 is in a Windows reserved range; avoid 54198-54397.

## D-005 AdminJS bundling at startup
AdminJS bundles custom components only when `NODE_ENV=production` (the Docker image sets it), into `.adminjs/` at startup (~30-60 s here). The bundle is cached: after adding or changing a component delete `.adminjs/` or the browser reports "Component ... has not been bundled". A fresh Docker build starts clean. The container's runtime user needs write access to it. Healthcheck/readiness must tolerate the delay.

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

## D-010 AdminJS resources are guarded (stage 5)
`GuardedResource` (`src/admin/guarded-resource.ts`) replaces the stock Prisma resource. AdminJS passes the action context to `find/count/findOne/findMany/create/update/delete`, so every data access knows the actor:
- Reads: mandatory scope AND-ed with user filters (Ticket: group scope; Group/Agent/User/Status: see `resources/reference.ts`). Custom filter conversion: case-insensitive `contains`, `__none__` on references means unassigned, malformed values match nothing instead of raising a database error. Page size is clamped to 100; `id` is a sort tie-breaker.
- Writes: only through `TicketService` / `CustomerService`; a resource without a write handler is read-only; `delete` always refuses. Generic delete and bulk delete are also marked inaccessible.
- Fields: `User.passwordHash`/`sessionVersion` are removed from every row for every actor; an AGENT receives only `displayName` of users.

AdminJS behaviours that shaped this (all covered by tests):
- `isAdapterFor` sees `model` + `client` on a resource instance and silently replaces it with the stock `Resource`. `GuardedResource` clears `client` after construction; removing that line disables every guard.
- A record counts as saved unless a *property* error exists. Errors without a field (version conflict) are attached to `fallbackErrorField` (`version` / `name`), otherwise the UI says "successfully updated" while nothing was saved.
- Refusals (not found, forbidden) come back as HTTP 200 with `record.baseError.type`; clients and tests must look at that, not at the status. Errors thrown as `DomainError` outside that path (e.g. creating in a foreign group) keep their HTTP status via the app error handler.
- `new` and `edit` share one visibility key (`edit`). `ReadOnlyWhenEditing` renders the stock select when creating and read-only text when editing. `version` is not a form field; it travels in the record params and is sent back on save.

Customers: any staff member creates; only ADMIN edits/deactivates (the `edit` action is hidden for AGENT and `CustomerService` refuses too). Customers are never deleted.

## D-011 Ticket actions, read models and custom components (stage 5b)
- **Actions.** `changeStatus` and `assignTicket` are AdminJS record actions with React forms (`ChangeStatusForm`, `AssignForm`); they POST to `TicketService`. Hidden record actions `formState`, `history` (Ticket) and `customerTickets` (Customer) return JSON for the components. The data comes from `TicketQueries`, which applies the same scope as the list: out-of-scope tickets behave as if absent.
- **AdminJS contract.** A record action must return `{ record }` (RecordJSON) or it throws `ConfigurationError`; our data rides along next to it. Unlike the built-in actions, our mutation actions answer with real HTTP statuses (`422` + `details`, `409`, `403`) so the forms can show field errors. When AdminJS cannot load the record at all (outside the scope) it answers HTTP 200 with a `NotFoundError` base error before our handler runs.
- **The forms only offer what the server will accept** (`formState` lists the transitions allowed for this actor and status, and the active members of the selected group), but the service re-validates everything.
- **Saved filters.** The dashboard shows live counts and links to ticket-list URLs: "My tickets" (`filters.assignedAgent=<agentId>`), "Unassigned" (`filters.assignedAgent=__none__`), "Waiting for customer" and "Unresolved" (`filters.status=<id>`). Counts and lists share one scope, so they always agree.
- **History** is read-only, newest first, 20 per page, with ids resolved to names. **Age** is computed on read (`age.ts`), never stored.
- **Labels and help text** come from `field-catalog.ts`. AdminJS `PropertyOptions` has no `label`: labels are generated as locale translations (`catalogTranslations()`), help text goes in `description`.
- **Components load from `dist/`** when it exists (they import each other with `.js` specifiers). For `npm run dev` run `npm run build` once, or `npm run build:watch` alongside, and delete `.adminjs/` after changing a component (D-005).
- **UI language is English** (requirements are English; UNRESOLVED is "Unresolved" there). A Russian UI would be a locale in `field-catalog.ts` plus translations of the component strings. Open question for the product owner.

## D-012 Staff, groups and statuses (stage 6)
All writes go through `UserService`, `AgentService`, `GroupService` and `StatusService`, which are ADMIN-only; the AdminJS forms only expose what may be edited.

**Accounts**
- Role and password never travel through the profile form: `UserService.update` accepts only name, email and active state (strict schema), and the form rejects a changed role or a password with a pointer to the right action. Roles change with **Change role**, passwords with **Set password**.
- Role change, password change and activation/deactivation bump `sessionVersion`, so the person is signed out on the next request (tested end to end over HTTP).
- Nobody changes their own role or deactivates themselves (no self-escalation, no self-lockout). The last active ADMIN can be neither demoted nor deactivated; the check runs under `SELECT ... FOR UPDATE` on all active admins, because without the lock two admins demoting each other at once both succeed and leave none (the test repeats the race 12 times and fails without the lock).
- An AGENT always has an active support profile (created with the account or on demotion). Deactivating the account deactivates the profile, which is refused while it holds active tickets; reactivating an AGENT account reactivates the profile. A rename propagates to the profile name. An ADMIN gets a profile through the Agent resource ("create profile"), which is what makes them assignable.
- A profile cannot be switched off on its own if it belongs to an AGENT account (an AGENT must always have an active profile, requirements section 5: deactivate the account instead, which also signs the person out) or to the caller (no self-lockout through the Agent resource). That leaves ADMIN accounts that work tickets and stop doing so. Found by code review of stage 6.
- Passwords: 12-256 characters, length only (no composition rules), Argon2id. There is no self-service password change yet.
- Created and updated rows are redacted like reads, so a new account never echoes its hash.

**Groups**: the code is immutable and validated (`[A-Z][A-Z0-9_]{1,39}`); deactivation is refused while the group has active tickets; only active agents join active groups; removing a member is refused while they hold active tickets in the group. An AGENT can read the member list of their own group (names only); ADMIN gets add/remove and the candidate list.

**Statuses**: only name, color, order and active flag change; the code is fixed. NEW can never be deactivated and a status that tickets use cannot be. A deactivated status is no longer offered by the forms and is refused as a transition target (`FOR SHARE` on the target, `FOR UPDATE` on deactivation, same pattern as agents). New statuses need a migration and workflow tests; the resource has no "create".

**Forms**: `ModeField` (formerly ReadOnlyWhenEditing) renders per mode from `property.custom.mode`: read-only on edit, create-only, or edit-only, because AdminJS shares one visibility key between new and edit.

**Testing note**: the last-admin tests switch other active admins off for the duration of the test and always restore them. Run integration tests against a throwaway database, not one with real accounts.

## D-013 Shared guards
`requireAdmin(actor)` lives in `src/policies/ticket-policy.ts` and is the only way services refuse non-administrators; `isUniqueViolation` (P2002) and `isRecordNotFound` (P2025) live in `src/domain/db.ts`. Do not copy them into services.
