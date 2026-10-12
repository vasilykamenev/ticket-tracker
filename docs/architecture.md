# Architecture

How the application is put together: the parts, the order a request passes through them, and where each rule lives.
Diagrams are [Mermaid](https://mermaid.js.org/); GitHub draws them. Related: [database](database.md),
[authentication](authentication.md), [workflow](workflow.md), [deployment and operations](operations.md),
[decisions](decisions.md).

## The parts

```mermaid
flowchart LR
    B["Browser<br/>AdminJS single-page app"] -->|HTTPS| C["Caddy<br/>certificates, compression,<br/>12 MB body limit"]
    C -->|"HTTP :3000, private network"| A

    subgraph A["Application container (Node 22, Express 4)"]
        direction TB
        MW["Middleware<br/>headers, session, CSRF, authentication"]
        ADM["AdminJS 7<br/>guarded resources + React components"]
        INT["/internal routes<br/>attachments, AI field help"]
        DOM["Domain services + policies<br/>all business rules"]
        MW --> ADM --> DOM
        MW --> INT --> DOM
    end

    DOM -->|"Prisma, runtime role"| PG[("Supabase PostgreSQL<br/>schema support")]
    MW -->|"sessions (pg pool)"| PG
    INT -->|"S3 API, private bucket"| ST[("Supabase Storage")]
    INT -.->|"optional, AI_ENABLED=true"| AI["Claude API"]
    MW -.->|"optional OAuth"| OA["Google / GitHub"]
```

| Part | Responsibility |
| --- | --- |
| **Caddy** | Terminates HTTPS (certificate from Let's Encrypt, renewed by itself), redirects HTTP to HTTPS, compresses, caps the request body at 12 MB, takes an unhealthy instance out of rotation using `/health/live`. The application has no published port. |
| **Express app** (`src/app.ts`) | Assembles the middleware in a fixed order (below), mounts the sign-in routes, the internal API and AdminJS, and turns every error into a JSON answer without leaking details. |
| **AdminJS** (`src/admin`) | The screens. Resources are `GuardedResource` wrappers: reads are scoped to the person's groups, writes go through domain services, the generic delete is switched off. Custom React components draw the ticket header, inline comments, history, and the status, assign and bulk forms. |
| **Domain** (`src/domain`, `src/policies`) | Services (`TicketService`, `CommentService`, `AttachmentService`, `UserService`, ...) own every business rule and run each operation in one transaction. Policies are pure functions of the actor and the data (`ticket-policy.ts`, `comment-policy.ts`). |
| **Storage** (`src/storage`) | An `ObjectStorage` interface with an S3 implementation (Supabase) and an in-memory one for development and tests. |
| **Assistant** (`src/assistant`) | Optional AI field help; off unless `AI_ENABLED=true` (D-025). |
| **CLI** (`src/cli`) | Operator commands compiled into the image: create an administrator, seed the reference data and the demo dataset, check or reconcile storage, provision database roles, smoke test. |

## The request pipeline

The order is fixed in `src/app.ts` and matters: each step relies on the ones before it.

```mermaid
flowchart TD
    R["Request"] --> H["Security headers<br/>nosniff, frame deny, referrer policy, HSTS in production"]
    H --> HL{"/health/live, /health/ready<br/>/, /auth/logo.png, /auth/login-art.png"}
    HL -->|"answered here:<br/>no session is created"| X1(["response"])
    HL -->|otherwise| S["Session<br/>express-session, store in PostgreSQL"]
    S --> JS["/auth/csrf-client.js<br/>(and the AI widget when enabled)"]
    JS --> P["/auth form parser<br/>urlencoded, 4 KB"]
    P --> CS["CSRF check on unsafe methods<br/>Origin + token"]
    CS --> AU["/auth routes<br/>login, OAuth, logout, csrf token"]
    CS --> IN["/internal<br/>requireUser, then attachments and AI help"]
    CS --> AD["/admin<br/>requireUser, bulk-selection limit, AdminJS router"]
    AU --> X2(["response"])
    IN --> X2
    AD --> X2
    X2 -.->|any error| E["Error handler<br/>DomainError keeps its status,<br/>everything else is a generic 500"]
```

`requireUser` reloads the user from the database on every request. That is what makes a deactivation, a role change or a
password change effective immediately (see [authentication](authentication.md)).

## Where a rule lives

A rule is checked at the layer that owns it, and the layers above only *offer* what the layer below will accept:

| Layer | What it does | Can it be bypassed? |
| --- | --- | --- |
| Screens (React, AdminJS options) | Hide buttons and fields, offer only the valid choices | Yes, by a hand-made request. It is a convenience, not a control. |
| `GuardedResource` | Applies the person's scope to every read (list, count, search, show, reference lookups); refuses writes that have no service handler | No: AdminJS cannot reach the table except through it. |
| Domain services | Role, scope, workflow, validation (Zod, strict objects), optimistic locking, history | No: the only code that writes. |
| Database | Foreign keys with `ON DELETE RESTRICT`, unique indexes, `FOR SHARE` / `FOR UPDATE` row locks, a runtime role without DDL rights | The last line: even a bug in the application cannot drop a table or delete a referenced row. |

## One operation end to end: changing a ticket's status

```mermaid
sequenceDiagram
    autonumber
    participant UI as Browser (ChangeStatusForm)
    participant MW as Session, CSRF, requireUser
    participant AJ as AdminJS action
    participant TS as TicketService
    participant DB as PostgreSQL

    UI->>MW: POST /admin/api/resources/Ticket/records/{id}/changeStatus<br/>Origin + X-CSRF-Token, {version, targetStatus, ...}
    MW->>DB: load the session, then the user (role, active, sessionVersion)
    MW->>AJ: request with the signed-in actor
    AJ->>TS: changeStatus(actor, id, version, input)
    TS->>DB: BEGIN
    TS->>DB: load the actor's scope, then the ticket inside it (404 if outside)
    TS->>TS: check the version, find the transition, check role, reason,<br/>resolution, assignee, active group and agent
    TS->>DB: lock the target status FOR SHARE (it cannot be deactivated meanwhile)
    TS->>DB: UPDATE ticket SET status, outcome fields, version = version + 1<br/>WHERE id AND version = {version}
    TS->>DB: INSERT history (STATUS_CHANGED, before, after, reason)
    TS->>DB: COMMIT
    TS-->>AJ: the updated ticket
    AJ-->>UI: 200, the page reloads
```

If any step fails, the transaction rolls back and the person gets the error on the form: a refused rule is a 422 with the
field names, a stale version is a 409, an out-of-scope ticket is a 404 (existence is not disclosed).

The edit form's Status field takes the same path: `TicketService.updateWithStatus` runs this change and the field edits in
one transaction (D-027). Bulk change applies the same function to up to 100 tickets in one transaction (D-016).

## Source layout

```
src/
  app.ts, server.ts          assembly and start-up
  config/env.ts              the whole configuration, validated once at start-up
  auth/                      login, sessions, CSRF, OAuth, password hashing, requireUser
  admin/                     AdminJS resources, field catalog, React components (components/)
  domain/                    services and queries: tickets, comments, attachments, customers, groups, users, statuses
  policies/                  pure access rules (scope, comment permissions)
  http/                      security headers, upload and bulk limits, /internal routes
  storage/                   object storage (S3, in-memory), file validation, reconcile
  assistant/                 optional AI field help
  ops/, cli/, seed/          database roles, operator commands, the demo dataset
prisma/                      schema and migrations
public/                      the CSRF client script, the AI widget, logo and sign-in picture
deploy/vps/                  compose.yaml, Caddyfile, deploy.sh, bootstrap.sh, operator tools
tests/                       unit and integration suites
```

## Why these choices

The reasoning, with the alternatives that were considered, is in [decisions.md](decisions.md). The ones that shape the
structure: business rules in services and policies instead of AdminJS hooks (D-009), guarded resources (D-010), one
login controller with sessions in PostgreSQL, so a restart signs nobody out (D-006), CSRF (D-007), two database roles on
Supabase (D-020), delivery to a VPS behind Caddy (D-022).
