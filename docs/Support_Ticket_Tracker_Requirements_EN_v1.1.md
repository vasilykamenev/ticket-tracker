# Support Ticket Tracker

Version 1.1 · 10 October 2026 · Part 1. Requirements and architecture (EN)

The version 1.1 package contains sections 1–14 in this file. Sections 15–19 are in `Support_Ticket_Tracker_Runbook_RU_v1.1.md`, available in Russian only. The Russian equivalent of this part is `Support_Ticket_Tracker_Requirements_RU_v1.1.md`. References [1–11] are listed in the appendix and in section 19 of Part 2.

## 1. Basis and document scope

Source: “Engineer Take-Home — Task Package.pdf”, 6 pages. The selected domain is option 3, “Support Ticket Tracker”, in Part 1, page 1. General requirements are on pages 2–4, the grading rubric is on pages 4–5, and review questions are on pages 5–6.

This is a development specification, including the command contract for the future repository. It is not a working application: the npm scripts, migrations, components, and workflows described here must be implemented before following the run instructions. Deployment and compatibility of a specific dependency set were not tested while preparing this document.

User decisions: AdminJS for the interface; PostgreSQL and S3-compatible storage in one Supabase project; management of tickets, users, groups, and statuses; configuration generated through code; reproducible seed data.

Design decisions in this document: TypeScript + Node.js + Express + Prisma; one application and one application Docker container; application-managed server sessions; ADMIN and AGENT permission levels; customer requests entered by staff. A customer portal, customer login, and inbound email are not required by the original brief and are outside the initial release.

## 2. Application purpose

An internal web application for support staff. A staff member opens `/admin`, signs in, finds a ticket, assigns a group and an agent, changes its status, and adds comments and attachments. Administrators manage staff, groups, customers, and status reference data presentation.

The original domain entities are retained: Ticket, Customer, Agent, and Comment. User stores the staff login account; Agent is its support profile. Additional tables support groups, attachments, statuses, auditing, and sessions. They are not separate subsystems.

Supabase provides PostgreSQL and Storage. The Node.js process must run on a separate host supporting a long-lived Docker container. Supabase does not replace Express/AdminJS application hosting. Supabase Auth, Realtime, and the public Data API are not used in the baseline design.

## 3. Mapping to the original assignment

| Source requirement | Implementation / evidence |
|---|---|
| Selected domain, p. 1 | Ticket, Customer, Agent, Comment; status workflow and comment attachments |
| FK and M:N, p. 1 | Ticket → Customer; Agent ↔ SupportGroup through AgentGroup |
| Generated admin interface, p. 1 | AdminJS resources with configured standard lists and forms |
| Real backend and business logic, p. 2 | Express, Prisma, TicketService; status transitions and assignment rules |
| File/image field, p. 2 | Comment attachments field, files in Storage, metadata in Attachment |
| Meaningful and reproducible seed data, p. 2 | 300 customers, 15 agents, 2000 tickets, 10000 comments, 200 files |
| Real authentication, p. 2 | Argon2id, PostgreSQL sessions, logout, and access revocation |
| Two genuinely different roles, pp. 2–3 | ADMIN and AGENT; restrictions on menus, actions, records, and fields |
| CSRF, validation, HTTPS, secrets, p. 2 | Section 9 and Part 2 section 15; rejected-request tests |
| Customization of at least two models, p. 3 | Ticket and Customer columns, filtering, and search |
| Inline editing of a related model, p. 3 | Create and edit Comment within a Ticket detail view |
| Custom admin action, p. 3 | bulkChangeStatus for selected tickets |
| Managed database and object storage, p. 3 | Supabase PostgreSQL and a private Storage bucket |
| Uploads never land on local disk, p. 3 | Dedicated upload handler with a bounded memory buffer |
| Live deployment, p. 3 | HTTPS application URL with a protected admin interface |
| Production assets, debug off, environment configuration, p. 3 | Production Docker build, prepared AdminJS bundle, environment secrets |
| Live URL, public GitHub, README, pp. 3–4 | Final delivery package in Part 2 section 18 |
| AI assistant bonus, p. 3 | Optional widget grounded in actual field metadata, section 12 |
| OAuth bonus, p. 2 | Outside the baseline; rationale and future access policy documented |
| Automated testing bonus, p. 2 | Included: workflow, RBAC, and attachment tests |
| Stack and scope rationale, pp. 1, 3–4 | README, decisions below, and explicitly deferred features |

The source rubric assigns 12% to data modeling, 18% to admin customization, 15% to authentication/roles/security, 8% to business logic, 12% to deployment, 8% to database/storage, 15% to the AI bonus, 7% to code quality, and 5% to communication. AI remains a bonus under the brief despite its separate rubric weight. It must not replace working deployment, admin customization, or RBAC.

## 4. Architecture and technology choices

| Component | Purpose |
|---|---|
| Node.js, TypeScript, ESM | One language for server code, configuration, and small UI components |
| Express + `@adminjs/express` | HTTP, authentication, middleware, and AdminJS routing |
| AdminJS + `@adminjs/prisma` | Generate the CRUD interface from Prisma resources [1–3] |
| Prisma + PostgreSQL | Typed data access, relationships, migrations, and transactions |
| Supabase PostgreSQL | Managed database for domain data and sessions |
| Supabase Storage through AWS SDK v3 | S3-compatible file operations [7–8] |
| Argon2id, express-session, connect-pg-simple | Password hashing and server-side sessions |
| Zod or equivalent | Server DTOs and environment validation |
| Bounded in-memory multipart parser | Uploads without temporary disk files |
| Vitest, Supertest, Playwright | Business rules, HTTP/security, and a short UI smoke suite |
| Docker + GitHub Actions + GHCR | Build, verify, and deliver the container |

A separate Next.js application, Java backend, Redis, message broker, or microservice architecture is unnecessary for this scope. The same application serves AdminJS static assets. The hosting reverse proxy terminates TLS.

All browser operations pass through the application server. Only the server connects to PostgreSQL and S3. Database credentials, S3 secrets, and privileged Supabase keys must never reach the browser.

### 4.1 Package compatibility

Start by verifying compatibility among AdminJS, its Express plugin, the Prisma adapter, Prisma Client/CLI, and Node.js. Do not automatically install the newest major version of every package. Validate a working combination in a small prototype and pin exact versions in package.json, the lock file, and the Node image. Prisma CLI and Client versions must be aligned.

The prototype must open a Ticket resource, perform a foreign-key lookup, save a record, build a custom component, and run from the production image. Record the exact tested versions in the README. Datasource and client-generation configuration must match the chosen Prisma version; do not mix examples from different major versions.

## 5. Data model

Use UUID primary keys for entities and a separate unique sequence for ticket numbers. Store timestamps as PostgreSQL timestamptz in UTC. Create foreign keys and unique constraints through migrations. User and Agent must not duplicate password or role data.

| Table | Fields and constraints |
|---|---|
| User | id, normalizedEmail unique, displayName, passwordHash, role ADMIN/AGENT, isActive, sessionVersion default 1, createdAt, updatedAt |
| Agent | id, userId unique FK User, displayName, isActive; support profile; User.role determines permissions |
| Customer | id, name, emailNormalized unique, company nullable, phone nullable, isActive, createdAt, updatedAt |
| SupportGroup | id, code unique immutable, name, description nullable, isActive |
| AgentGroup | id UUID PK, agentId FK, groupId FK, unique(agentId, groupId); explicit M:N relationship |
| TicketStatus | id, code unique immutable, name, color, sortOrder, isActive; fixed system codes |
| Ticket | id, number unique, subject, description, customerId FK, groupId FK, assignedAgentId nullable FK, statusId FK, priority enum, resolution nullable, unresolvedReason nullable, resolvedAt nullable, unresolvedAt nullable, closedAt nullable, createdByUserId FK, version default 1, createdAt, updatedAt |
| Comment | id, ticketId FK, authorUserId FK, body, version default 1, createdAt, updatedAt |
| Attachment | id, commentId FK, bucket, objectKey unique, originalName, contentType, sizeBytes, sha256, state PENDING/READY/FAILED/DELETING, createdByUserId FK, createdAt |
| TicketHistory | id, ticketId FK, actorUserId FK, kind, before JSONB, after JSONB, reason nullable, createdAt |
| Session | connect-pg-simple-compatible schema: sid PK, sess JSON, expire timestamp; expire index |

An ADMIN User does not have to have an Agent profile. An AGENT User must have an active Agent profile. Anyone who can be assigned a ticket, including an administrator, must first have an Agent profile and belong to the relevant group.

A Customer does not automatically receive an account. All MVP comments are entered by staff and the history remains internal. Public customer replies and an internal/public flag should be introduced only together with a delivery channel or customer portal.

Deactivate reference records and users rather than deleting them. Foreign keys with RESTRICT prevent deletion of referenced Customer, Agent, Group, Status, and User records. Ticket history is not editable or deletable through the UI. Tickets have no ordinary hard-delete action. Seed reset is a separate maintenance operation restricted to an authorized demo environment.

### 5.1 Validation and indexes

Project limits: subject 5–200 characters, description 1–1000, comment.body 1–5000, resolution and unresolvedReason 10–2000, name 1–200. Priority values: LOW, NORMAL, HIGH, URGENT. Normalize email before persistence; HTML input type=email is not sufficient validation.

Ticket indexes: `(groupId, statusId, updatedAt)`, `(assignedAgentId, statusId, updatedAt)`, `(customerId, createdAt)`. Comment: `(ticketId, createdAt)`. History: `(ticketId, createdAt)`. AgentGroup: unique pair and a groupId index. Include id as a sort tie-breaker for stable pagination. Start with ticket number/subject and customer name/email search, without Elasticsearch. Measure queries before adding trigram or full-text indexes as data grows.

### 5.2 Field definitions and configuration

Define fields in Prisma, server DTOs, and `field-catalog.ts`. The catalog contains labels, helpText, types, required flags, limits, visibility rules, and allowed values. Generate AdminJS properties and AI context from it. Do not automatically expose every database column: explicitly exclude passwordHash, sessionVersion, Session, and internal object keys through an allowlist.

Schema changes are code and migration changes. The MVP has no runtime designer for arbitrary SQL columns. Users may change status names/order/colors and reference records, but cannot change column types through the admin. If no-code custom fields become necessary, design FieldDefinition and Ticket.customFields JSONB separately.

## 6. Workflow and business rules

System statuses: NEW, IN_PROGRESS, WAITING_CUSTOMER, RESOLVED, UNRESOLVED, CLOSED. Codes and the transition matrix are defined in code. Editable display names do not change their meaning.

UNRESOLVED is displayed as “Unresolved” in English and “Не решено” in Russian. It ends the current handling attempt without a solution, for example because of a technical limitation or missing required information. Unlike NEW or WAITING_CUSTOMER, active work has stopped rather than not yet started or temporarily awaiting a reply. unresolvedReason is required and must contain 10–2000 characters. RESOLVED means a solution was found; CLOSED means administrative closure of a resolved ticket. Do not move unresolved tickets to CLOSED: retain their distinct outcome as UNRESOLVED.

In the interface and reports, distinguish active tickets (NEW/IN_PROGRESS/WAITING_CUSTOMER), solved tickets (RESOLVED/CLOSED), and unresolved tickets (UNRESOLVED). Show all six statuses separately when needed. Do not count UNRESOLVED as successfully solved.

| From | To | Condition |
|---|---|---|
| NEW | IN_PROGRESS | An active assignee belongs to the ticket's active group |
| IN_PROGRESS | WAITING_CUSTOMER | An assignee is set; a waiting reason is required |
| WAITING_CUSTOMER | IN_PROGRESS | Resume work with an active assignee |
| IN_PROGRESS, WAITING_CUSTOMER | RESOLVED | Resolution contains at least 10 characters; an assignee is set |
| IN_PROGRESS, WAITING_CUSTOMER | UNRESOLVED | ADMIN or AGENT within scope; an active assignee is set; unresolvedReason is required |
| UNRESOLVED | IN_PROGRESS | ADMIN or AGENT within scope; a reopening reason and an active assignee are required |
| RESOLVED | CLOSED | ADMIN only; closure reason is optional |
| RESOLVED | IN_PROGRESS | Reopening reason is required |
| CLOSED | IN_PROGRESS | ADMIN only; reopening reason and an active assignee are required |

The server assigns NEW at creation. Reject any transition not listed above. CLOSED and UNRESOLVED tickets cannot be edited through ordinary forms or receive new comments; an authorized reopening is required first. Comments on RESOLVED tickets may be edited according to role rules.

`changeStatus(actor, ticketId, expectedVersion, targetStatus, reason, resolution, unresolvedReason)` checks access, current version, transition, and input data. Update Ticket, increment version, and insert TicketHistory in one transaction. RESOLVED sets resolvedAt and resolution. UNRESOLVED sets unresolvedAt and unresolvedReason and clears resolvedAt/resolution/closedAt. CLOSED sets closedAt and retains the confirmed solution. Reopening clears resolvedAt/unresolvedAt/closedAt and current resolution/unresolvedReason, preserving previous values in history. Accept outcome fields only for the matching target status. UNRESOLVED has no direct transition to RESOLVED or CLOSED: return to IN_PROGRESS before recording a new work outcome. Return 409 on a version conflict and ask the user to refresh the record.

Change group and assignee through `assignTicket`, not a generic update. A new assignee must belong to the new group. Clearing the assignee during a group change is allowed only for NEW; otherwise assign a valid agent in the same transaction. Removing membership or deactivating an agent with active assigned tickets (NEW, IN_PROGRESS, WAITING_CUSTOMER) requires reassignment first. Reject group deactivation while it has active tickets. RESOLVED, CLOSED, and UNRESOLVED retain historical assignments even if an agent/group is later deactivated. Before reopening, reactivate the group and assign an active agent atomically with the transition. Other changes to CLOSED and UNRESOLVED are prohibited; RESOLVED remains editable according to the permission matrix while its group is active. ADMIN may close RESOLVED without reactivating its historical assignee.

A system status cannot be deactivated while tickets reference it. NEW cannot be deactivated because it is required for creation. Adding a new status code requires a workflow change and tests in code. Status administration is not an unrestricted workflow designer.

### 6.1 Bulk status changes

Custom bulk action `bulkChangeStatus`: at most 100 tickets per request, a target status, a reason, and either resolution or unresolvedReason as required by the target status. For UNRESOLVED, the shared form reason applies to every selected ticket; the operator must confirm that it is appropriate for all of them. Check access and version for each ticket. Use all-or-nothing semantics: roll back the entire transaction on any failure and show ticket numbers and rejection reasons. The action is available to ADMIN and AGENT within their scope.

The client submits id/version pairs. Deduplicate ids and validate batch size before querying the database. For 500 tickets, the operator uses five batches; the MVP does not promise an atomic 500-record operation. A background job with progress reporting is a future extension.

## 7. Roles and data access

| Operation | ADMIN | AGENT |
|---|---|---|
| View tickets | All | Only tickets in the agent's groups |
| Create a ticket | Any active group | Own groups only |
| Edit description/priority | All except CLOSED/UNRESOLVED | Accessible tickets except CLOSED/UNRESOLVED |
| Assign an agent | Any valid group; CLOSED/UNRESOLVED only through reopening | Accessible groups only; CLOSED/UNRESOLVED only through reopening |
| Transitions/bulk actions | Workflow rules, including ADMIN-only transitions | Workflow rules, excluding ADMIN-only transitions |
| Customers | Create, view, edit, deactivate | View/search/create; no editing or deactivation |
| Comments | Create and edit, except on CLOSED/UNRESOLVED | Create; edit own comments on accessible tickets except CLOSED/UNRESOLVED |
| Delete comments | Disabled in MVP | Disabled |
| Attachments | Read according to ticket access; upload/delete through the service only outside CLOSED/UNRESOLVED | Read according to ticket access; upload/delete on own comments only outside CLOSED/UNRESOLVED |
| Staff, roles, groups, memberships | Manage | Read minimal agent data needed for assignment within own groups |
| Statuses | Edit permitted reference fields | Read available statuses only |
| History | Read | Read history of accessible tickets only |

Project simplification: Customer is a shared staff directory. This is explicitly not a multi-tenant system. AGENT can see known customer names and email addresses, but cannot discover out-of-scope tickets through a customer record. If customer isolation by organization is required, change the model and scope before implementation.

Enforce access at three levels: middleware loads the active user from the database; AdminJS hides unavailable resources/buttons; domain services check roles and scope on every read and write. AdminJS RBAC requires configuration in code; hiding a button is not authorization [4].

Apply restrictions to list/count/show/search/reference lookups, inline actions, bulk operations, history, and downloads. Combine user filters with the mandatory scope using AND; query parameters cannot replace the scope. Do not fetch all records and filter them in the browser. An out-of-scope recordId returns 404 without disclosing that the record exists. Reject unknown or forbidden DTO fields instead of letting them pass through.

User editing must prevent self-escalation and deactivation of the last active ADMIN. A user cannot set a role through a generic profile form. Changes to role, password, or active state increment sessionVersion; a version mismatch invalidates the session on the next request.

## 8. AdminJS views and code generation

AdminJS generates CRUD for registered resources; configuration determines lists, fields, and actions [2, 5]. The generated interface remains the application foundation. Do not replace it with a custom SPA.

| Resource / view | Required configuration |
|---|---|
| Ticket list | number, subject, customer, group, assignee, status, priority, updatedAt; updatedAt DESC sorting; page sizes 25/50/100 |
| Ticket filters/search | Status, group, assignee, priority, customer, date range; ticket number/subject substring; presets “My tickets”, “Unassigned”, “Waiting for customer”, “Unresolved” |
| Ticket show/edit | Main fields, separate assign/changeStatus actions, CommentsInline, history; computed age without persistence |
| Customer list | name, email, company, isActive; name/email search and isActive/company filters |
| Customer show | Contact details and paginated tickets restricted to staff scope |
| Agent/User | Staff lists, activity, role, separate safe password-setting actions; never serialize password hashes |
| SupportGroup | Name, description, activity, group membership editing |
| TicketStatus | name, color, sortOrder; read-only code; new codes through migrations |
| Comment | Primary access through Ticket inline; a separate list is optional |

### 8.1 Actual inline editing

`CommentsInline.tsx` in the Ticket view shows a page of comments, an add button, in-place text editing, and attachments. Saving must not navigate to a separate Comment page. The server derives ticketId from the current recordId and authorUserId from the session. AGENT sees Edit only for their own comments. For CLOSED/UNRESOLVED, hide add/edit/upload controls for every role; retain scoped reading and downloading. The backend repeats the same check. Comment has its own version field to protect concurrent edits.

Register the component through ComponentLoader as a custom property in Ticket show/edit views. Use AdminJS design-system components and its API client where appropriate [6]. Comments remain unavailable until the parent Ticket has been saved and has an id.

The ready-made `@adminjs/relations` extension is paid [10]. The baseline has no license dependency: small custom CommentsInline and GroupMembers components within the generated admin are sufficient. Installing relations alone does not prove the inline-editing requirement is met: verify that editing happens inside the Ticket view rather than solely by navigating to another record page.

### 8.2 Generated elements

Generate property configuration, labels/help text, and static help from `field-catalog.ts` and an explicit resource registry. Prisma generates the Client; migrations and seed scripts live in the repository. AdminJS generates forms and lists at runtime. Load reference data through an idempotent script.

Business rules, permissions, and secret-field exclusion remain explicit, reviewed code. An unrestricted generic CRUD generator without an allowlist is prohibited. An AI coding assistant may generate files from this specification, but every implementation stage must end with a runnable result and a separate commit.

## 9. Authentication and security

Baseline: local staff authentication, an Argon2id hash in User, and server-side PostgreSQL sessions. Use a dedicated login controller and one session middleware instance, followed by the protected AdminJS router. The integration must populate currentAdmin from the verified session according to the chosen plugin version. If using `buildAuthenticatedRouter`, verify shared session/CSRF middleware rather than creating two incompatible sessions. The Express plugin supports an authenticated router and PostgreSQL session storage [1].

Implementation requirements:

1. Verify passwords with an Argon2 library; tune its parameters and document them in the README. Do not copy a demo login with credentials embedded in code. Unknown email and incorrect password must produce the same login error.
2. Rate-limit login attempts by IP and account. An in-memory limiter is acceptable for a single-replica demo if its limitation is documented. Multiple replicas need a shared counter.
3. Regenerate the session id at login. Store only userId, sessionVersion, and session timing, not a password hash. Destroy the server session on logout.
4. Cookies: HttpOnly, SameSite=Lax, Secure in production. Enforce both a 30-minute idle timeout and an 8-hour absolute lifetime on the server. Configure proxy trust for the actual reverse proxy only.
5. CSRF: store a synchronizer token in the session. The login form uses a hidden token; every POST/PUT/PATCH/DELETE requires a token, including generated actions, bulk operations, uploads, and logout. Add shared token-header handling to the AdminJS client. Check Origin as an additional measure. SameSite is not a substitute for the token. GET must not mutate data.
6. Validate the token header before reading an upload body. Allow a bounded URL-encoded body for the ordinary HTML login form. Test actual middleware order in the chosen AdminJS plugin; do not assume built-in protection.
7. Render comments as escaped plain text. Never execute HTML/scripts. Use parameterized queries, server DTOs, and sort/filter allowlists.
8. Limit JSON body size, search length, page size, bulk size, and upload concurrency. Errors must not return stack traces, database URLs, or secrets.
9. Secrets belong in environment variables or a secret store. Ignore `.env` and demo credentials in Git. Logs must not contain passwords, tokens, presigned URLs, or complete ticket bodies.
10. Run the application with minimal database privileges. The runtime role does not own the schema, perform DDL, or access Supabase system schemas. Migration credentials are available only to the migration stage.

Use a separate PostgreSQL schema, `support`, not exposed through the Data API. Do not grant Supabase anon/authenticated access to it. A server-side ORM connection does not automatically inherit each staff member's row-level permissions: the application enforces group isolation. If using public schema instead, explicitly restrict API access with grants/RLS and test it; this document's baseline uses support.

OAuth is deferred as a bonus. If added, a new OAuth identity must not receive administrator access by default and cannot sign in without an invitation or ADMIN approval. It requires separate client id/secret values and verified redirect URIs.

## 10. Attachments and S3

Use one private bucket, `ticket-attachments`; public URLs are prohibited. Supabase provides an S3-compatible API but not every AWS S3 capability. The MVP requires PutObject, GetObject, HeadObject, and DeleteObject [7–8]. Application CSS/JS may reside in the image; user uploads must not be stored on the server's disk.

Selected path: browser → authenticated/CSRF-protected upload handler → bounded RAM buffer → S3. Do not use a default multipart parser that writes temporary files. Mount the dedicated upload route before the general AdminJS parser. Enforce file-count and size limits before buffering the entire body.

Project limits: one file per upload request, up to 10 MiB, at most 5 attachments per comment; PNG, JPEG, PDF, UTF-8 TXT. Validate extension, content type, and file signature/content. Reject SVG, HTML, executables, and archives. Validate text decoding and reject binary content for TXT. The client filename is metadata only. The server generates objectKey as `tickets/{ticketId}/comments/{commentId}/{uuid}`. Do not accept a bucket or object key supplied by the browser.

Upload sequence:

1. Check the user, ticket scope, permission to edit Comment, ticket status (not CLOSED/UNRESOLVED), file-count limit, size, and type.
2. Create Attachment PENDING with a unique key. Enforce the concurrent five-file limit using a Comment lock in a short transaction, counting both PENDING and READY records.
3. Execute PutObject without a local file.
4. Set Attachment to READY. Only READY attachments are downloadable.
5. On failure, set FAILED and attempt to delete any created object. Do not report success.

For downloads, recheck parent-ticket access and issue a presigned GET valid for 60 seconds with Content-Disposition attachment. The URL remains valid until expiry even after role revocation; document this limitation. S3 credentials provide privileged access and do not replace ticket-level authorization [8].

Deletion: set DELETING, delete the object, then remove metadata. Repeated deletion must be idempotent. PostgreSQL and S3 do not share a transaction. `storage:reconcile` processes stale PENDING/FAILED/DELETING records and discovered objects and produces a report. For PENDING older than one hour, delete the object and mark the record FAILED. Run it manually or on a GitHub Actions schedule. Support `--dry-run` before actual deletion.

Antivirus scanning and quarantine are future extensions. Files must not be executed, published, or rendered as active content. MIME validation must not be described as antivirus protection.

## 11. Additional API requirements

No separate API service or public REST API is required. AdminJS actions already expose HTTP endpoints [5]. Their handlers invoke domain logic; standard new/edit/delete actions must not bypass services.

Implement a small set of routes in the same Express application. These are internal endpoints, not a second backend.

| Endpoint / action | Purpose |
|---|---|
| GET/POST `/auth/login`, POST `/auth/logout` | Login/logout, session handling, CSRF |
| GET `/auth/csrf` | Token for the current or pre-login session; same-origin, no-store |
| AdminJS Ticket `new`, `edit` | Creation and allowed ordinary edits through TicketService |
| AdminJS Ticket `changeStatus`, `assignTicket`, `bulkChangeStatus` | Validated business operations |
| AdminJS Ticket `listComments`, `addComment`, `editComment` | Inline component; all operations scoped, listing paginated |
| POST `/internal/comments/:id/attachments` | In-memory upload with RBAC and CSRF |
| GET `/internal/attachments/:id/download` | Scope check and redirect to a short-lived signed URL |
| DELETE `/internal/attachments/:id` | Authorized deletion with CSRF |
| GET `/health/live` | Process is running; no configuration details |
| GET `/health/ready` | Valid configuration and database availability; verify storage separately with a smoke/check command |
| POST `/internal/assistant` | Enabled AI bonus only |

Generated AdminJS action URLs depend on the selected version and action type: resource, record, or bulk. The frontend uses ApiClient instead of guessing URLs. New business mutations use POST only. Disable or fully replace standard action handlers that could bypass the workflow. A before hook performing UI validation alone is insufficient.

## 12. Optional AI support chat

Enable through `AI_ENABLED=true` after completing the mandatory scope. The widget resides in AdminJS and answers questions about the current form's fields. An external provider is not required for the base application. Select the model and pricing separately; free usage is not guaranteed.

The client sends resourceId, fieldId, and a question of up to 1000 characters. The server checks the user's access to the form/field and retrieves label, helpText, type, required flags, validations, and permitted statuses/transitions from field-catalog, including the distinction between UNRESOLVED, WAITING_CUSTOMER, and RESOLVED. Do not send raw tickets, customer data, passwordHash, or secrets. Form context supplied by the browser is untrusted.

The model instruction requires answers based only on supplied context, no invented values or permissions, and an explicit acknowledgment when information is missing. The user's question is data, not a replacement system instruction. The model cannot write data or invoke tools. Render answers as safe text.

Limits: 10 requests per minute per user, a bounded answer, a 10-second timeout, and a daily budget. On timeout/429/5xx, show the same field's static help and an AI-unavailable message; the rest of the admin continues working. The README records the provider, model, environment configuration, limitations, and the reason for skipping the bonus if it is not implemented.

## 13. Seed data

Seed data is part of the deliverable. A fixed pseudorandom seed and stable UUIDs/natural codes make reruns reproducible. All email addresses use `example.test`; all identities and business data are fictional.

| Dataset | Volume / variants |
|---|---|
| Accounts | 2 ADMIN accounts without Agent; 15 AGENT accounts with Agent |
| Groups | 5: General, Billing, Integrations, Platform, Access |
| Memberships | 25 relationships, with several agents in two groups |
| Customers | 300 with varied names and companies |
| Tickets | 2000 across the previous 90 days, all priorities and groups |
| Statuses | 500 NEW, 600 IN_PROGRESS, 300 WAITING_CUSTOMER, 300 RESOLVED, 100 UNRESOLVED, 200 CLOSED |
| Comments | 10000; 0–20 per ticket, distributed to produce the exact total |
| Attachments | 200 actual safe PNG/JPEG/PDF/TXT files in Storage, usually up to 50 KiB |
| History | Actual permitted transitions leading to each ticket's current state |

NEW includes unassigned tickets; other seeded tickets have valid assignees. Dates and history are consistent: createdAt ≤ comment/transition time ≤ updatedAt. CLOSED passes through RESOLVED. UNRESOLVED passes through IN_PROGRESS or WAITING_CUSTOMER and contains unresolvedReason/unresolvedAt. The six status counts total 2000 tickets. Include a history of reopening from UNRESOLVED and subsequently resolving the ticket. Include long subjects, Cyrillic text, similar customer names, missing phone numbers, multiple comment pages, and tickets belonging to other groups for RBAC checks.

All seed attachments are actually uploaded to S3; database references must not be fictitious. Fixtures may be committed to the repository and uploaded from memory through the same storage service. This does not permit storing user uploads on the application server's disk.

### 13.1 Seed commands

- `npm run seed:reference`: upsert system statuses and reference records by code.
- `npm run seed:demo -- --seed 42`: create/update only the owned dataset without duplicating rows on reruns.
- `npm run seed:verify`: verify counts, foreign keys, workflow, memberships, and the presence of seed objects in Storage.
- `npm run seed:reset -- --dataset takehome-demo --confirm takehome-demo`: delete only the demo dataset and its S3 prefix, then recreate it.
- `npm run admin:create -- --email admin@example.test`: safely bootstrap the first ADMIN; obtain the password from a hidden prompt/environment variable, never a password CLI argument.

Track dataset ownership through a seed registry of record ids/object keys or a separate deterministic namespace. Reset must not DROP SCHEMA, TRUNCATE all tables, or purge the bucket. Require `ALLOW_DEMO_RESET=true`, `APP_ENV=demo|development`, and exact dataset confirmation. Always reject production resets. Dry-run shows counts before deletion. Respect foreign-key dependencies and storage states when ordering cleanup.

Seed administrator/agent passwords come from local secret environment variables and are hashed. There is no public default password. Seed must not reset an existing password without an explicit `--rotate-demo-passwords`. Reviewer credentials are shared separately from the public repository. Two demo accounts may be shared through a protected channel to demonstrate role differences.

## 14. Repository structure and implementation sequence

```text
support-ticket-tracker/
  src/
    app.ts
    server.ts
    config/env.ts
    auth/
    domain/tickets/
    domain/comments/
    domain/users/
    domain/groups/
    policies/
    storage/
    admin/resources/
    admin/actions/
    admin/components/
    admin/field-catalog.ts
    admin/component-loader.ts
    http/routes/
    assistant/
  prisma/schema.prisma
  prisma/migrations/
  scripts/
  seed/fixtures/
  tests/unit/
  tests/integration/
  tests/e2e/
  docs/decisions.md
  docs/acceptance.md
  .github/workflows/ci.yml
  .github/workflows/deploy.yml
  .env.example
  .gitignore
  .dockerignore
  Dockerfile
  compose.yaml
  package.json
  package-lock.json
  README.md
```

Recommended sequence, with verification after every stage:

1. Package compatibility: minimal AdminJS + Prisma + production bundle; pin the tested versions.
2. Supabase development project and support schema; model migrations, foreign keys, indexes, runtime database role, and Session.
3. Authentication/session/CSRF before exposing the admin. Bootstrap ADMIN and test login/logout and rejected requests.
4. Policies and domain services; unit/integration tests for workflow, assignment, and optimistic locking.
5. Ticket and Customer resources: lists, search, filters, permissions, and prevention of generic-action bypasses.
6. Users, Agents, Groups, memberships, and constrained Status administration.
7. CommentsInline: create/edit within the Ticket view; protect author and ticket identifiers.
8. Storage upload/download/delete, memory limits, reconciliation, and real fixtures.
9. bulkChangeStatus and history; verify rollback of the entire batch.
10. Full seed/reset/verify; filters and pagination with 2000 tickets.
11. Production Docker build and CI; HTTPS deployment and smoke tests using both roles.
12. AI bonus if time permits, then README, evidence checklist, and review preparation.

Do not start the AI bonus before authentication, inline editing, storage, and the live URL work. A successful `npm run build` alone does not mean the project is complete.

## Appendix. Technical sources

Sources carried forward from the original document and checked on 10 October 2026. Version 1.1 workflow changes are project requirements.

1. AdminJS Express integration: https://docs.adminjs.co/installation/plugins/express
2. AdminJS resources: https://docs.adminjs.co/basics/resource
3. AdminJS Prisma adapter: https://docs.adminjs.co/installation/adapters/prisma
4. AdminJS RBAC configuration: https://docs.adminjs.co/tutorials/adding-role-based-access-control
5. AdminJS actions: https://docs.adminjs.co/basics/action
6. AdminJS custom components: https://docs.adminjs.co/ui-customization/writing-your-own-components
7. Supabase S3 compatibility: https://supabase.com/docs/guides/storage/s3/compatibility
8. Supabase S3 authentication: https://supabase.com/docs/guides/storage/s3/authentication
9. Supabase PostgreSQL connection modes: https://supabase.com/docs/guides/database/connecting-to-postgres
10. AdminJS relations, licensing: https://docs.adminjs.co/basics/features/relations
11. Supabase bucket creation: https://supabase.com/docs/guides/storage/buckets/creating-buckets
