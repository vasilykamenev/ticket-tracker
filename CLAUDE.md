# CLAUDE.md — Ticket Tracker UI Redesign

Read this file first, in full, at the start of every session. It tells you what the project is, how to work, and in which order to do the tasks.

## 1. Project

An existing AdminJS application used as a ticket tracker. Goal: turn it into a full agent-facing ticket tracker without changing the data model.

Current state (review of 13 Oct 2026):

- Resources: Ticket, Customer, Support Group, Agent, Ticket Status, User. Custom page: "My open tickets".
- About 50,000 tickets. The dashboard has four static counters (Unassigned, Waiting for customer, Unresolved, All tickets).
- Ticket fields: Number, Subject, Customer, Group, Assignee, Status, Priority, Description, Age, Resolution, Unresolved reason, Resolved at, Marked unresolved at, Closed at, Created by, Updated at, Version.
- The ticket page is one long vertical list of fields. Comments (with attachments: PNG, JPEG, PDF, TXT, up to 5 files, 10 MiB each) and History are two separate sections.
- Existing actions: Edit, Change status, Assign.

Main problems to fix: no queue workflow (views, search, bulk actions), a ticket page that is hard to read and act on, a dashboard that does not link anywhere, and no shared visual system.

## 2. Rules of work

- Do the tasks in the order of section 5. Finish and verify one task before starting the next.
- Use AdminJS extension points only (custom components via `ComponentLoader`, custom actions, `dashboard`, `branding`, `overridableComponents`). Do not fork AdminJS and do not edit `node_modules`.
- Do not change the database schema, SLA rules or the permission model. If a task seems to need it, stop and ask.
- Never delete or bulk-overwrite data. Bulk actions must go through the existing update logic so that History events are still written.
- Test credentials are given by the user in chat. Never write them into files, commits or logs.
- Keep UI text in English and route it through AdminJS translations so a locale can be added later.
- Prefer small commits, one per task or sub-step, with a message that names the task ID (for example `T3: two-column ticket page`).
- After each task: run build, lint and tests; open the changed screen in the browser; check it with the real 50,000-ticket data; then tick the box in section 6 and add a one-line note.
- If something is unclear or two reasonable options exist, stop and ask with the options listed. Do not guess on anything that is hard to undo.

## 3. Shared design rules

Apply these in every task.

- **Type scale:** field labels at least 12 px; contrast at least WCAG AA; one heading scale across all pages.
- **Status colors** (same everywhere: list, ticket page, dashboard, history): New = blue, In progress = indigo, Waiting for customer = yellow, Resolved = green, Closed = grey.
- **Priority:** colored marker plus the text label (HIGH, NORMAL, LOW); never color alone.
- **Dates:** one formatting helper for the whole app. Relative time in lists and timelines ("2 days ago"), full date and time in a tooltip.
- **Empty fields:** hide them on read-only views.
- **Do not cover content:** the floating help button must not overlap the last list column or form buttons.

## 4. Task format

Each task below has Goal, Steps and Done when. A task is complete only when every "Done when" line is true.

## 5. Tasks, in order

### Phase 1 — Foundation

**T0. Discover the codebase** (no code changes)

- Goal: know where everything lives before editing.
- Steps:
  1. Find the AdminJS setup file, resource definitions, the component loader, existing custom actions (Change status, Assign), the dashboard and the "My open tickets" page.
  2. Find how comments, attachments and history events are stored and how history text ("Status changed", "Assigned", reason) is produced.
  3. Find the existing branding and theme configuration and the logo file.
  4. Write the findings as a short "Codebase map" section at the end of this file (paths only, no long prose).
- Done when: the Codebase map lists the file for each item above, and the app starts locally with the test data.

**T1. Theme and tokens** (R18, R19, R20)

- Goal: one visual system applied to the existing screens.
- Steps:
  1. Configure `branding` (theme, company name, compact logo about 40–48 px high).
  2. Define tokens for type scale, status colors and spacing in one place; apply them.
  3. Move the floating help button so it does not overlap content.
  4. Add a dark theme if AdminJS `branding.theme` supports it in the installed version; otherwise note it as skipped.
- Done when: list, form and ticket pages use the new tokens with no layout breakage; labels are at least 12 px; the help button covers nothing.

**T2. Shared UI components** (R12, R18)

- Goal: reusable building blocks for later tasks.
- Steps: create `StatusBadge`, `PriorityMarker`, `RelativeTime` (with full-date tooltip) and a single date-format helper, all based on `@adminjs/design-system`.
- Done when: each component is used in at least one existing screen and matches section 3.

### Phase 2 — Agent workflow

**T3. Ticket page layout** (R1, R3, R4)

- Goal: a readable two-column ticket page.
- Steps:
  1. Replace the default `show` with a custom component.
  2. Left column: heading `#<Number> · <Subject>`, description, then a placeholder for the timeline (built in T5).
  3. Right column: properties panel with Status, Priority, Assignee, Group, Customer, Age.
  4. Hide empty fields; put Version, Created by, Updated at in a collapsed "Details" block.
- Done when: ticket 21609 opens in the new layout; no empty Resolution/Closed fields are shown; the page title shows the number and subject instead of "Show".

**T4. Inline editing and header actions** (R2)

- Goal: change status, assignee, priority, group without leaving the page.
- Steps:
  1. Turn the properties panel values into dropdowns that save on change.
  2. Move "Change status" and "Assign" into the page header as dropdown menus; reuse the existing actions so History is written.
  3. Show a short success or error message after each change; roll back the UI value if saving fails.
- Done when: changing status or assignee takes one dropdown selection, creates a History event, and survives a page reload.

**T5. Unified activity timeline** (R5, R6, R8)

- Goal: comments and history in one chronological feed.
- Steps:
  1. Merge comments and History events into one list, ordered by time.
  2. Render events as compact grey one-line items; render comments with author initials and relative time.
  3. Mark internal notes with a colored background and an "Internal" label.
  4. Replace "Earlier / Page 1 of 2 / Later" with "Show earlier (N)".
  5. Show attached files on a comment; remove the per-comment "Attach file 0 / 5" control.
- Done when: ticket 21609 shows all 20 comments and its 5 history events in one feed; internal notes are visually distinct; no per-comment attach control remains.

**T6. Reply editor** (R7)

- Goal: reply and set status in one step.
- Steps:
  1. Add an editor pinned to the timeline with a "Reply / Internal note" switch.
  2. Add attachments here with the existing limits (5 files, 10 MiB each, PNG/JPEG/PDF/TXT).
  3. Add "Send + set status" (for example "Send and set Waiting for customer"), writing both the comment and the status change.
  4. Keep the 5000-character limit and show the counter.
- Done when: an agent can post a reply or an internal note with an attachment and change status in one action, and both appear in the timeline.

**T7. Saved views in the list** (R9)

- Goal: queue tabs above the ticket list.
- Steps: add a list wrapper with tabs "My open", "Unassigned", "Waiting for customer", "All"; each tab sets `filters.*` in the query string so links are shareable; set sensible `listProperties` and default sort.
- Done when: each tab returns the correct tickets and its URL can be opened directly; counts per tab are shown if the query is fast enough on 50,000 rows, otherwise skip counts and note it.

**T8. Search** (R10)

- Goal: find a ticket by number or subject from the list header.
- Steps: add a search input mapped to a filter on Number and Subject; make sure the database query is indexed or otherwise fast on 50,000 rows.
- Done when: searching an exact ticket number returns it first, and a subject search returns results without a noticeable delay.

**T9. Bulk actions** (R11)

- Goal: process several tickets at once.
- Steps: add bulk actions (`actionType: 'bulk'`) for assign, change status, change priority and change group; each must write History events per ticket and report how many records changed.
- Done when: selecting 5 tickets and assigning them changes all 5 and creates 5 History events.

### Phase 3 — Overview and polish

**T10. List density and columns** (R12)

- Steps: compact row height (about 36 px); relative "Updated at"; add an Age column; priority color marker at the start of each row; check whether the "Problem: " prefix comes from the data and do not strip it in code without asking.
- Done when: at least 18 tickets fit on a 1544×784 screen.

**T11. Dashboard** (R13, R14)

- Steps: make every counter a link to the matching filtered list; add "My tickets" and "Created / closed today"; add a 14-day incoming chart and a distribution by group and agent; set the agent home page to "My queue".
- Done when: each counter opens the correct list and the number on the card equals the list count.

**T12. Navigation and top bar** (R15, R16)

- Steps: plural resource names (Tickets, Customers, Groups, Agents, Statuses, Users); "My open tickets" first, with a counter; hide it for users without an agent profile or show an empty state with a link to all tickets; add global search (`/` or Ctrl+K), a "+ New ticket" button and notifications to the top bar.
- Done when: menu and top bar match the list and the "My open tickets" page no longer shows only a banner.

**T13. Ticket creation form** (R17)

- Steps: layout Subject → Description (Markdown editor) with the properties on the right; default Priority = NORMAL; suggest Group from the selected customer; allow creating a customer from the dropdown.
- Done when: a ticket can be created with the minimum number of clicks and the defaults apply.

**T14. Final pass**

- Steps: check every screen against section 3; check keyboard focus and contrast; run the full test suite; update the Codebase map.
- Done when: all boxes in section 6 are ticked and a short summary of changes and known gaps is added at the end of this file.

## 6. Progress

Tick the box and add a one-line note when a task is finished and verified.

- [x] T0 Discover the codebase — map below; app runs locally (`/health/ready` 200), dev DB holds 2000 tickets, 10001 comments, 6550 history rows. Findings that change later tasks are listed under the map.
- [ ] T1 Theme and tokens
- [ ] T2 Shared UI components
- [ ] T3 Ticket page layout
- [ ] T4 Inline editing and header actions
- [ ] T5 Unified activity timeline
- [ ] T6 Reply editor
- [ ] T7 Saved views in the list
- [ ] T8 Search
- [ ] T9 Bulk actions
- [ ] T10 List density and columns
- [ ] T11 Dashboard
- [ ] T12 Navigation and top bar
- [ ] T13 Ticket creation form
- [ ] T14 Final pass

## 7. Open questions (ask the user before the related task)

- Which languages must the interface support, and which is the default? (before T1)
- Does the system store an SLA deadline per ticket, or only timestamps? (before T10)
- Should administrators without an agent profile see "My open tickets"? (before T12)
- Who approves the final status colors and the logo? (before T1)

## 8. Codebase map

Paths are relative to the repository root. The app root path is `/app`.

- **AdminJS setup:** `src/app.ts` (`buildAdmin`: `rootPath`, `branding`, `defaultTheme` + `availableThemes` from `@adminjs/themes`, `pages`, `dashboard`, `locale`, `resources`, `assets.scripts`)
- **Resources:** `src/admin/resources/ticket.ts`, `customer.ts`, `reference.ts` (Group, Agent, Status, User); shared helpers `helpers.ts`, `record-actions.ts`; reads/writes wrapper `src/admin/guarded-resource.ts`
- **Component loader:** `src/admin/component-loader.ts` (list `NAMES` + `Components`); components in `src/admin/components/*.tsx`; browser API helper `components/api.ts`
- **Custom actions:** in `src/admin/resources/ticket.ts`: `changeStatus` (form `ChangeStatusForm`), `assignTicket` (`AssignForm`), `bulkChangeStatus` (bulk, `BulkChangeStatusForm`), data actions `formState`, `listComments`, `addComment`, `history`
- **Dashboard:** component `src/admin/components/Dashboard.tsx`; data `TicketQueries.dashboard` in `src/domain/tickets/ticket-queries.ts`
- **"My open tickets":** page `src/admin/components/MyOpenTickets.tsx`, registered in `src/app.ts` (`pages`)
- **Ticket page:** `TicketHeader.tsx`, `StatusBadge.tsx`, `PriorityBadge.tsx`, `Badge.tsx` (`Pill`), `CommentsInline.tsx`, `TicketHistory.tsx`; `showProperties` order in `ticket.ts`
- **Comments and attachments:** schema `prisma/schema.prisma` (`Comment`, `Attachment`); services `src/domain/comments/*`, `src/domain/attachments/attachment-service.ts`; limits and file checks `src/storage/`
- **History:** table `TicketHistory` (`kind`, `before`, `after`, `reason`); written in `src/domain/tickets/ticket-service.ts` (`tx.ticketHistory.create`), read by `TicketQueries.history`; labels (Created, Edited, Assigned, Status changed) in `components/TicketHistory.tsx`
- **Workflow and rules:** `src/domain/tickets/workflow.ts`, `src/policies/ticket-policy.ts`, `comment-policy.ts`, `age.ts`
- **UI text and field help:** `src/admin/field-catalog.ts` (`catalogTranslations`), `locale` in `src/app.ts`
- **Branding and theme:** `branding` and `defaultTheme: light` in `src/app.ts`; logo `public/logo.png` (served at `/auth/logo.png`), login picture `public/login-art.png`; status colors `STATUS_COLORS` in `components/StatusBadge.tsx`; no shared tokens file yet
- **Floating help button:** `public/assistant-widget.js` (loaded only when `AI_ENABLED=true`)
- **Ticket list:** `listProperties`, filters and sort in `src/admin/resources/ticket.ts`; page size `settings.defaultPerPage` in `src/app.ts`
- **Tests:** `tests/unit`, `tests/integration` (see `tests/README.md`); run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`
- **Run locally:** `npm run dev:db` (embedded PostgreSQL on 15432, `.devdb/`), `npm run dev` (port 3000, bundles AdminJS on start); demo data `npm run seed:demo`

### Findings that affect later tasks

- Already present, so the tasks refine rather than create: `StatusBadge`, `PriorityBadge` (T2), `bulkChangeStatus` (T9), inline comments with attachments (T5), `history` action, dashboard with saved-filter counts (T11), light/dark themes (T1).
- Status colors today: New = violet, In progress = blue, Waiting = amber, Resolved = green, Unresolved = red, Closed = grey. Section 3 says New = blue, In progress = indigo and has no Unresolved color. Needs a decision before T1.
- `Comment` has no internal-note flag, so "Internal note" (T5, T6) needs a schema change, which rules forbid. Needs a decision before T5.
- `Ticket` stores only timestamps (no SLA deadline).
- Local data is 2000 tickets, not 50,000. Ticket 21609 from the done-when lines does not exist locally, so use any seeded ticket.
- Bulk actions today: change status only. Assign, priority and group (T9) are new.
