# The interface

How the panel looks and works, the design rules behind it, where each screen lives in the code, and what was left out on purpose. The business rules behind the screens are in [workflow.md](workflow.md); the pipeline that serves them is in [architecture.md](architecture.md).

The panel is AdminJS 7 with the light theme (the moon icon switches to the dark one). It is built only with AdminJS extension points: custom React components, custom actions, the dashboard handler, branding, translations and overridden core components. Nothing in `node_modules` is changed, and the data model and the permissions are untouched: every change a screen makes goes through the same domain services as before, so scope, optimistic locking, the workflow and the history behave as they always did.

## Screens

| Screen | What it does |
| --- | --- |
| **Sign-in** (`/auth/login`) | Password and optional Google / GitHub sign-in. Same footer as the panel. |
| **Dashboard** | For an agent it opens with **My queue** (the newest open tickets assigned to them). Every counter is a link to the ticket list with the same filters and the same scope, so the number on a card is the number in the list: My open, All my, Unassigned, Waiting for customer, Unresolved, Created today, Closed today (UTC), Open, All. Below: tickets created per day over 14 days, and **Open tickets by group / by agent** as one row each with a bar split by status in the status colors (the exact numbers are in the tooltip). |
| **Ticket list** | Tabs above the table: **Open** (the default: every status except CLOSED), **My open**, **Unassigned**, **Waiting for customer**, **All**. A tab only sets filters in the address, so a view can be shared as a link; each tab shows a count. **All** is `?view=all`; a list opened without any filter shows Open. **My open** is greyed out for an account without an agent profile. Rows are compact (about 36 px), with a priority marker in front of the number, an Age column and a relative Updated at. The paginator is one rounded bar with a clear current page. |
| **Bulk actions** | Select tickets in the list: Change status, **Assign**, **Change group**, **Change priority**. Up to 100 tickets, all or nothing, every refused ticket is named, each ticket gets its own history entry, the versions the person saw travel back so a ticket edited meanwhile is refused instead of overwritten. |
| **Ticket page** | Two columns. Left: the description, the outcome (when there is one) and the **activity feed**. Right: the properties. Status, Priority, Assignee and Group are dropdowns that save when changed, through the existing actions; a status change that needs a reason or an outcome opens the full Change status form. **Change status** and **Assign** are also menus in the header. A success or error notice follows each change and the old value stays on screen if saving fails. Empty fields are not shown; Created by, Created, Updated and Version are in a collapsed **Details** block. |
| **Activity feed** | Comments and history events in one chronological list: events are compact grey lines, comments carry the author's initials and a relative time (the full date is in the tooltip). "Show earlier (N)" reveals older entries. Files are listed under their comment. |
| **Reply editor** | Under the feed: text (5000 characters, with a counter), up to 5 files of 10 MiB (PNG, JPEG, PDF, TXT), **Send**, and **Send and set status**, which posts the reply and then changes the status; the reply text serves as the reason or the outcome. Posting and the status change are two calls, so if the second is refused the reply stays and the message says so. |
| **New ticket** | Subject and description on the left, the properties on the right. Priority starts as NORMAL; choosing a customer suggests the group of their latest ticket that the person may use; a customer who is not in the directory yet can be added without leaving the form. |
| **Other forms** | Customer, Group, Agent, Status, User and the ticket edit form share the same two-column layout: the fields in a wide panel, switches and dates in a narrow one. A status colour is chosen from a colour palette (with the hex code beside it). |
| **Top bar** | Ticket search (a number finds that ticket, any other text is looked for in the subjects; `/` or Ctrl+K from anywhere), **+ New ticket**, and a bell with the number of open tickets assigned to the signed-in agent. |
| **Menu** | Plural names (Tickets, Customers, Groups, Agents, Statuses, Users). The queue "My open" is a tab of the list, not a menu page. |
| **Footer** | "© 2026 Vasily Kamenev" on every page; the name opens a new e-mail to the author (`src/author.ts`). |
| **Sign out** | One click: the link is turned into a POST with the CSRF token by `public/csrf-client.js`. `GET /auth/logout` shows a confirmation page and changes nothing; it is the fallback (see [authentication.md](authentication.md)). |

## Design rules

- **One place for the look:** `src/admin/tokens.ts` (type sizes, spacing, the colours of statuses and priorities, chart colours) and `public/theme.css` (served at `/auth/theme.css`, revalidated on every load).
- **Type:** field labels are never smaller than 12 px; text keeps WCAG AA contrast (checked by `tests/unit/tokens.test.ts`); keyboard focus is always visible.
- **Status colours,** the same in the list, the ticket page, the dashboard and the history: New blue, In progress indigo, Waiting for customer yellow, Resolved green, Unresolved red, Closed grey. Bars and charts use stronger tones of the same families.
- **Priority** is a coloured marker with its name written next to it, never colour alone.
- **Dates:** one helper (`src/admin/format.ts`). Relative time in lists and feeds ("2 days ago"), the full date and time in a tooltip.
- **Empty fields** are hidden on read-only views.
- **The floating AI help button** never covers content: the content area keeps room below its last element.
- **Text** is English and goes through AdminJS translations, so a locale can be added later.

## Where things are

Paths are relative to the repository root. The root path of the panel is `/app`.

- **AdminJS setup:** `src/app.ts` (`buildAdmin`: `rootPath`, `branding`, themes, `dashboard`, `locale`, `resources`, `assets` for `/auth/theme.css` and the scripts)
- **Resources and actions:** `src/admin/resources/ticket.ts` (list, show, new and edit actions; `changeStatus`, `assignTicket`, `setPriority`, `timeline`, `formState`, `newFormState`, `addComment`, `editComment`, `history`, and the bulk actions `bulkChangeStatus`, `bulkAssign`, `bulkChangeGroup`, `bulkChangePriority`), `customer.ts`, `reference.ts`; helpers `helpers.ts` (two-column layout) and `record-actions.ts`; the guarded wrapper `guarded-resource.ts`
- **Components:** `src/admin/components/*.tsx`, registered in `src/admin/component-loader.ts` (the list `NAMES`, `Components`, and the overrides of `TopBar` and `Footer`). Page: `TicketPage`, `ActivityFeed`. List: `TicketList`, `TicketNumberCell`. Forms: `TicketNewForm`, `BulkEditForm` with `BulkAssignForm`, `BulkGroupForm`, `BulkPriorityForm`, `ColorField`. Shared: `StatusBadge`, `PriorityBadge`, `PriorityMarker`, `RelativeTime`, `Dashboard`, `TopBar`, `Footer`
- **Data for the screens:** `TicketQueries` (`dashboard`, `bulkAssignState`, `suggestGroup`, `historyAll`, `formState`) in `src/domain/tickets/ticket-queries.ts`, `CommentQueries.listAll`; bulk changes `bulkAssign` and `bulkSetPriority` in `src/domain/tickets/ticket-service.ts`
- **Look:** `src/admin/tokens.ts`, `src/admin/format.ts`, `public/theme.css`, the logo `public/logo.png` (shown 132 px high), the sign-in picture `public/login-art.png`
- **Comments, files, history:** tables `Comment`, `Attachment`, `TicketHistory` in `prisma/schema.prisma`; services in `src/domain/comments`, `src/domain/attachments`; the history text is built in `TicketQueries.history`

## Changing the interface

- The panel is served from compiled files: after editing a component run `npm run build` (the dev server then bundles it again). A change that is only type-checked does not reach the browser.
- A new component needs a file in `src/admin/components`, an entry in `NAMES` and in `Components` in `component-loader.ts`, and a use in a resource. One component per file.
- Run locally: `npm run dev:db` (embedded PostgreSQL on port 15432, keep it open), `npm run dev` (port 3000), demo data with `npm run seed:demo`.
- Tests: the screens' data and actions are covered by `tests/integration/bulk-assign.test.ts` and `admin-redesign.test.ts`; the look rules by `tests/unit/tokens.test.ts` and `format.test.ts` (see [../tests/README.md](../tests/README.md)).

## Left out on purpose

- **Internal notes.** They need a flag on `Comment`, which is a schema change. Every comment is visible to the whole team.
- **SLA** timers, deadlines and views. Out of scope; only the existing Age is shown.
- **A Markdown editor** for the description. The text is plain and line breaks are kept.
- **"My open tickets" first in the menu with a counter.** AdminJS lists pages after resources; the queue is a tab of the list and the count is in the top bar bell.
- **A search index.** The search is a case-insensitive "contains" on the subject; an index would be a schema change. Measure it on a very large data set before relying on it.

## Ideas not built

Taken from Zendesk, Help Scout, Front, Linear and Zammad. Those that need no schema change: a customer context card on the ticket page, a next-ticket flow ("Send and go to next", "Take next ticket" with an atomic assignment), keyboard shortcuts and a command palette, and a Reports page (read-only queries). Those that need new tables, so need a decision first: macros (saved replies), tags and followers, @mentions with notifications, collision warnings (presence), SLA policies, merging and linking tickets, automation rules, a satisfaction rating (also needs an outgoing e-mail channel).

## Known gaps

- The screens were verified by type checks, the AdminJS bundle build and tests; check them once by eye after a change of this size.
- The demo data set holds 2000 tickets; the speed of the list and the search was not measured on 50,000.
- `npm run lint` cannot run: `eslint` is not a dependency of the project.
