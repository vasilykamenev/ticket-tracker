import { findTransition, isFrozen, isStatusCode } from '../domain/tickets/workflow.js';
import { DEFAULT_TICKETS, MAX_COMMENTS_PER_TICKET, TICKET_WINDOW_DAYS, type Snapshot, sizesFor, statusCountsFor } from './dataset.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
const DEMO_ADDRESS = /@example\.test$/;

/** The part of the dataset the consistency checks need. A generated dataset and rows read from the database both fit. */
export interface DatasetView {
  users: Array<{ id: string; email: string; role: string }>;
  agents: Array<{ id: string; userId: string; isActive?: boolean }>;
  groups: Array<{ id: string; name: string }>;
  memberships: Array<{ agentId: string; groupId: string }>;
  customers: Array<{ id: string; name: string; email: string; phone: string | null; createdAt: Date }>;
  tickets: Array<{
    id: string;
    subject: string;
    priority: string;
    customerId: string;
    groupId: string;
    assignedAgentId: string | null;
    status: string;
    resolution: string | null;
    unresolvedReason: string | null;
    resolvedAt: Date | null;
    unresolvedAt: Date | null;
    closedAt: Date | null;
    version: number;
    createdAt: Date;
    updatedAt: Date;
  }>;
  history: Array<{
    ticketId: string;
    actorUserId: string;
    kind: string;
    before: Snapshot | null;
    after: Snapshot;
    reason: string | null;
    createdAt: Date;
  }>;
  comments: Array<{ id: string; ticketId: string; authorUserId: string; createdAt: Date; updatedAt: Date }>;
  attachments: Array<{ commentId: string; state?: string; createdAt?: Date }>;
}

export interface CheckResult {
  problems: string[];
  /** Counts that are worth showing next to a passing run. */
  stats: Record<string, number>;
}

const PER_KIND_LIMIT = 5;

/** Counts and collects problems; at most a few examples per kind so one systematic fault stays readable. */
class Report {
  readonly problems: string[] = [];
  private readonly seen = new Map<string, number>();
  add(kind: string, detail: string) {
    const n = (this.seen.get(kind) ?? 0) + 1;
    this.seen.set(kind, n);
    if (n <= PER_KIND_LIMIT) this.problems.push(`${kind}: ${detail}`);
  }
  finish(): string[] {
    for (const [kind, n] of this.seen) if (n > PER_KIND_LIMIT) this.problems.push(`${kind}: ... and ${n - PER_KIND_LIMIT} more`);
    return this.problems;
  }
}

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as string | Date).toISOString());
const str = (s: Snapshot | null, key: string): string | null => (s && typeof s[key] === 'string' ? (s[key] as string) : null);

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length]!;
}

/**
 * Checks the demo dataset against requirements section 13: volumes, memberships, assignees, that every ticket's
 * history is a chain of permitted transitions ending in its current state, and that dates and comments agree.
 */
export function checkDataset(view: DatasetView, options: { referenceDate?: Date; tickets?: number } = {}): CheckResult {
  const SIZES = sizesFor(options.tickets ?? DEFAULT_TICKETS);
  const report = new Report();
  const stats: Record<string, number> = {};
  const expect = (what: string, actual: number, wanted: number) => {
    stats[what] = actual;
    if (actual !== wanted) report.add('count', `${what} is ${actual}, expected ${wanted}`);
  };

  // ---- volumes
  const roleOf = new Map(view.users.map((u) => [u.id, u.role]));
  const agentUserIds = new Set(view.agents.map((a) => a.userId));
  expect('admin accounts', view.users.filter((u) => u.role === 'ADMIN').length, SIZES.admins);
  expect('agent accounts', view.users.filter((u) => u.role === 'AGENT').length, SIZES.agents);
  expect('agents', view.agents.length, SIZES.agents);
  expect('groups', view.groups.length, SIZES.groups);
  expect('memberships', view.memberships.length, SIZES.memberships);
  expect('customers', view.customers.length, SIZES.customers);
  expect('tickets', view.tickets.length, SIZES.tickets);
  expect('comments', view.comments.length, SIZES.comments);
  expect('attachments', view.attachments.length, SIZES.attachments);
  for (const u of view.users) {
    if (!DEMO_ADDRESS.test(u.email)) report.add('accounts', `${u.email} is not an example.test address`);
    if (u.role === 'ADMIN' && agentUserIds.has(u.id)) report.add('accounts', `admin ${u.id} has an Agent profile`);
    if (u.role === 'AGENT' && !agentUserIds.has(u.id)) report.add('accounts', `agent account ${u.id} has no Agent profile`);
  }
  for (const [status, wanted] of Object.entries(statusCountsFor(SIZES.tickets))) {
    expect(`tickets ${status}`, view.tickets.filter((t) => t.status === status).length, wanted);
  }
  for (const a of view.attachments) if (a.state !== undefined && a.state !== 'READY') report.add('attachments', `state ${a.state}`);

  // ---- memberships and references
  for (const c of view.customers) if (!DEMO_ADDRESS.test(c.email)) report.add('customers', `${c.email} is not an example.test address`);
  const inactiveAgents = new Set(view.agents.filter((a) => a.isActive === false).map((a) => a.id));
  const groupIds = new Set(view.groups.map((g) => g.id));
  const customerIds = new Set(view.customers.map((c) => c.id));
  const membersOf = new Map<string, Set<string>>();
  const groupsOf = new Map<string, number>();
  for (const m of view.memberships) {
    if (!groupIds.has(m.groupId)) report.add('references', `membership of unknown group ${m.groupId}`);
    (membersOf.get(m.groupId) ?? membersOf.set(m.groupId, new Set()).get(m.groupId)!).add(m.agentId);
    groupsOf.set(m.agentId, (groupsOf.get(m.agentId) ?? 0) + 1);
  }
  stats['agents in two groups'] = [...groupsOf.values()].filter((n) => n >= 2).length;
  if (stats['agents in two groups']! < 2) report.add('memberships', 'fewer than two agents belong to two groups');
  const customerFirstTicket = new Map<string, number>();

  // ---- tickets
  const historyOf = new Map<string, DatasetView['history']>();
  for (const h of view.history) (historyOf.get(h.ticketId) ?? historyOf.set(h.ticketId, []).get(h.ticketId)!).push(h);
  const commentsOf = new Map<string, DatasetView['comments']>();
  for (const c of view.comments) (commentsOf.get(c.ticketId) ?? commentsOf.set(c.ticketId, []).get(c.ticketId)!).push(c);
  const ticketIds = new Set(view.tickets.map((t) => t.id));
  for (const c of view.comments) if (!ticketIds.has(c.ticketId)) report.add('references', `comment of unknown ticket ${c.ticketId}`);

  // The 90-day window is measured from the reference date; when it is not known (checking the database) the
  // newest update stands in for it, with a day of slack.
  const newest = view.tickets.reduce((latest, t) => Math.max(latest, t.updatedAt.getTime()), 0);
  const reference = options.referenceDate?.getTime() ?? newest;
  const slack = options.referenceDate ? 0 : DAY_MS;
  const priorities = new Set(view.tickets.map((t) => t.priority));
  stats['priorities in use'] = priorities.size;
  for (const p of PRIORITIES) if (!priorities.has(p)) report.add('coverage', `no ticket has priority ${p}`);

  let unassignedNew = 0;
  let reopenedAndResolved = 0;
  for (const t of view.tickets) {
    if (!groupIds.has(t.groupId)) report.add('references', `ticket ${t.id} in unknown group`);
    if (!customerIds.has(t.customerId)) report.add('references', `ticket ${t.id} of unknown customer`);
    customerFirstTicket.set(t.customerId, Math.min(customerFirstTicket.get(t.customerId) ?? Infinity, t.createdAt.getTime()));

    if (t.createdAt.getTime() < reference - TICKET_WINDOW_DAYS * DAY_MS - slack) {
      report.add('dates', `ticket ${t.id} was created more than ${TICKET_WINDOW_DAYS} days before the reference date`);
    }
    if (t.updatedAt.getTime() > reference + slack) report.add('dates', `ticket ${t.id} was updated after the reference date`);

    // Assignees: NEW may be unassigned; every other ticket has an assignee who is a member of its group.
    if (t.assignedAgentId === null) {
      if (t.status === 'NEW') unassignedNew++;
      else report.add('assignee', `ticket ${t.id} (${t.status}) has no assignee`);
    } else if (!membersOf.get(t.groupId)?.has(t.assignedAgentId)) {
      report.add('assignee', `ticket ${t.id} is assigned to an agent outside its group`);
    } else if (inactiveAgents.has(t.assignedAgentId)) {
      report.add('assignee', `ticket ${t.id} is assigned to an inactive agent`);
    }

    // Outcome fields.
    if (t.status === 'RESOLVED' && !(t.resolution && t.resolvedAt)) report.add('outcome', `RESOLVED ticket ${t.id} lacks resolution/resolvedAt`);
    if (t.status === 'UNRESOLVED' && !(t.unresolvedReason && t.unresolvedAt)) report.add('outcome', `UNRESOLVED ticket ${t.id} lacks unresolvedReason/unresolvedAt`);
    if (t.status === 'CLOSED' && !(t.closedAt && t.resolution && t.resolvedAt)) report.add('outcome', `CLOSED ticket ${t.id} lacks closedAt or the confirmed resolution`);
    if (!['RESOLVED', 'CLOSED'].includes(t.status) && (t.resolution || t.resolvedAt)) report.add('outcome', `${t.status} ticket ${t.id} carries a resolution`);

    // History: a chain of permitted transitions from NEW to the current state.
    const events = [...(historyOf.get(t.id) ?? [])].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const first = events[0];
    if (!first || first.kind !== 'CREATED' || first.before !== null || str(first.after, 'status') !== 'NEW') {
      report.add('history', `ticket ${t.id} does not start with CREATED in NEW`);
      continue;
    }
    if (first.createdAt.getTime() !== t.createdAt.getTime()) report.add('dates', `ticket ${t.id}: CREATED is not at createdAt`);
    const statuses: string[] = ['NEW'];
    for (let k = 1; k < events.length; k++) {
      const e = events[k]!;
      const prev = events[k - 1]!;
      if (e.createdAt.getTime() <= prev.createdAt.getTime()) report.add('dates', `ticket ${t.id}: history is not in time order`);
      if (JSON.stringify(e.before) !== JSON.stringify(prev.after)) report.add('history', `ticket ${t.id}: entry ${k} does not continue from the previous one`);
      if (e.kind === 'STATUS_CHANGED') {
        const from = str(e.before, 'status');
        const to = str(e.after, 'status');
        if (!from || !to || !isStatusCode(from) || !isStatusCode(to)) {
          report.add('workflow', `ticket ${t.id}: unknown status in history`);
          continue;
        }
        const rule = findTransition(from, to);
        if (!rule) report.add('workflow', `ticket ${t.id}: ${from} -> ${to} is not a permitted transition`);
        else {
          if (rule.adminOnly && roleOf.get(e.actorUserId) !== 'ADMIN') report.add('workflow', `ticket ${t.id}: ${from} -> ${to} done by a non-admin`);
          if (rule.reason === 'required' && !e.reason) report.add('workflow', `ticket ${t.id}: ${from} -> ${to} has no reason`);
          if (rule.resolution && !(str(e.after, 'resolution') && e.after.resolvedAt)) report.add('workflow', `ticket ${t.id}: resolved without a resolution and date`);
          if (rule.unresolvedReason && !(str(e.after, 'unresolvedReason') && e.after.unresolvedAt)) {
            report.add('workflow', `ticket ${t.id}: marked unresolved without a reason and date`);
          }
        }
        statuses.push(to);
      } else if (e.kind === 'ASSIGNED') {
        const agent = str(e.after, 'assignedAgentId');
        if (!agent || !membersOf.get(t.groupId)?.has(agent)) report.add('assignee', `ticket ${t.id}: assigned in history to a non-member`);
      } else if (e.kind !== 'UPDATED') {
        report.add('history', `ticket ${t.id}: unknown entry kind ${e.kind}`);
      }
    }
    const last = events[events.length - 1]!;
    if (str(last.after, 'status') !== t.status) report.add('history', `ticket ${t.id}: history ends in ${str(last.after, 'status')}, the ticket is ${t.status}`);
    if ((last.after.assignedAgentId ?? null) !== t.assignedAgentId) report.add('history', `ticket ${t.id}: history ends with another assignee`);
    if (str(last.after, 'resolution') !== t.resolution || str(last.after, 'unresolvedReason') !== t.unresolvedReason) {
      report.add('history', `ticket ${t.id}: history ends with other outcome text`);
    }
    if (iso(last.after.resolvedAt) !== iso(t.resolvedAt) || iso(last.after.unresolvedAt) !== iso(t.unresolvedAt) || iso(last.after.closedAt) !== iso(t.closedAt)) {
      report.add('history', `ticket ${t.id}: history ends with other outcome dates`);
    }
    if (t.version !== events.length) report.add('history', `ticket ${t.id}: version ${t.version} but ${events.length} history entries`);
    if (last.createdAt.getTime() > t.updatedAt.getTime()) report.add('dates', `ticket ${t.id}: updatedAt is before its last history entry`);
    if (t.status === 'CLOSED' && !statuses.includes('RESOLVED')) report.add('workflow', `CLOSED ticket ${t.id} never passed RESOLVED`);
    if (t.status === 'UNRESOLVED' && !statuses.some((s) => s === 'IN_PROGRESS' || s === 'WAITING_CUSTOMER')) {
      report.add('workflow', `UNRESOLVED ticket ${t.id} never was in progress`);
    }
    const joined = statuses.join(',');
    if (/UNRESOLVED,IN_PROGRESS(,[A-Z_]+)*,RESOLVED/.test(joined)) reopenedAndResolved++;

    // Comments: inside the ticket's life, and never while it was CLOSED or UNRESOLVED.
    const list = commentsOf.get(t.id) ?? [];
    if (list.length > MAX_COMMENTS_PER_TICKET) report.add('comments', `ticket ${t.id} has ${list.length} comments`);
    for (const c of list) {
      if (c.createdAt.getTime() < t.createdAt.getTime() || c.updatedAt.getTime() > t.updatedAt.getTime() || c.updatedAt.getTime() < c.createdAt.getTime()) {
        report.add('dates', `ticket ${t.id}: a comment lies outside createdAt..updatedAt`);
      }
      let status = 'NEW';
      for (const e of events) {
        if (e.createdAt.getTime() <= c.createdAt.getTime()) status = str(e.after, 'status') ?? status;
      }
      if (isStatusCode(status) && isFrozen(status)) report.add('comments', `ticket ${t.id}: a comment was written while the ticket was ${status}`);
    }
  }
  stats['NEW unassigned'] = unassignedNew;
  stats['reopened from UNRESOLVED and resolved'] = reopenedAndResolved;
  if (unassignedNew === 0) report.add('assignee', 'no NEW ticket is unassigned');
  if (reopenedAndResolved === 0) report.add('workflow', 'no ticket was reopened from UNRESOLVED and then resolved');

  for (const c of view.customers) {
    const firstTicket = customerFirstTicket.get(c.id);
    if (firstTicket !== undefined && c.createdAt.getTime() > firstTicket) report.add('dates', `customer ${c.id} was created after their first ticket`);
  }

  // ---- the awkward cases the requirements ask for
  const perTicket = [...commentsOf.values()].map((l) => l.length);
  const special = {
    'long subjects (150+ chars)': view.tickets.filter((t) => t.subject.length >= 150).length,
    'Cyrillic subjects': view.tickets.filter((t) => /[А-Яа-яЁё]/.test(t.subject)).length,
    'customers without phone': view.customers.filter((c) => c.phone === null).length,
    'tickets with more than one page of comments': perTicket.filter((n) => n > 10).length,
    'tickets with 20 comments': perTicket.filter((n) => n === MAX_COMMENTS_PER_TICKET).length,
    'tickets without comments': view.tickets.length - perTicket.filter((n) => n > 0).length,
  };
  Object.assign(stats, special);
  for (const [what, n] of Object.entries(special)) if (n === 0) report.add('coverage', `no ${what}`);
  const byFirst = new Map<string, string[]>();
  for (const c of view.customers) {
    const key = c.name.split(' ')[0]!;
    (byFirst.get(key) ?? byFirst.set(key, []).get(key)!).push(c.name);
  }
  let similar = 0;
  for (const list of byFirst.values()) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (list[i] !== list[j] && editDistance(list[i]!, list[j]!) <= 2) similar++;
  }
  stats['pairs of similar customer names'] = similar;
  if (similar === 0) report.add('coverage', 'no customers with similar names');
  for (const g of view.groups) {
    if (!view.tickets.some((t) => t.groupId === g.id)) report.add('coverage', `group ${g.name} has no tickets`);
  }
  const commentById = new Map(view.comments.map((c) => [c.id, c]));
  const ticketById = new Map(view.tickets.map((t) => [t.id, t]));
  for (const a of view.attachments) {
    const comment = commentById.get(a.commentId);
    if (!comment) {
      report.add('references', `attachment of unknown comment ${a.commentId}`);
      continue;
    }
    if (!a.createdAt) continue;
    const ticket = ticketById.get(comment.ticketId);
    if (a.createdAt.getTime() < comment.createdAt.getTime() || (ticket && a.createdAt.getTime() > ticket.updatedAt.getTime())) {
      report.add('dates', `an attachment of ticket ${comment.ticketId} lies outside its comment..ticket updatedAt`);
    }
  }
  const perComment = new Map<string, number>();
  for (const a of view.attachments) perComment.set(a.commentId, (perComment.get(a.commentId) ?? 0) + 1);
  if ([...perComment.values()].some((n) => n > 5)) report.add('attachments', 'a comment has more than five attachments');

  return { problems: report.finish(), stats };
}
