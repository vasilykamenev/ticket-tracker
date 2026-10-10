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
