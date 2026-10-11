import { COMMENT_MAX } from '../domain/comments/schemas.js';
import { ticketSnapshot } from '../domain/tickets/snapshot.js';
import { type StatusCode, applyOutcome, findTransition, isFrozen } from '../domain/tickets/workflow.js';
import { makeJpeg, makePdf, makePng, makeText } from './files.js';
import { seedId } from './ids.js';
import * as names from './names.js';
import { Rng } from './rng.js';

export const DATASET = 'takehome-demo';

/** Requirements section 13: the exact volumes of the demo dataset. */
export const SIZES = { admins: 2, agents: 15, groups: 5, memberships: 25, customers: 300, tickets: 2000, comments: 10000, attachments: 200 } as const;
export const STATUS_COUNTS: Record<StatusCode, number> = { NEW: 500, IN_PROGRESS: 600, WAITING_CUSTOMER: 300, RESOLVED: 300, UNRESOLVED: 100, CLOSED: 200 };
export const MAX_COMMENTS_PER_TICKET = 20;
export const TICKET_WINDOW_DAYS = 90;
const ACCOUNT_AGE_DAYS = 500;
const ADMIN_NAMES = ['Marta Lindgren', 'Pavel Orlov'] as const;
/** Share of tickets per group, in the order of `names.GROUPS`. */
const GROUP_WEIGHTS = [28, 20, 20, 20, 12] as const;
/** Agents who also belong to a second group: the 25 memberships minus the 15 primary ones. */
const SECOND_GROUP_AGENTS = SIZES.memberships - SIZES.agents;
/** Customers 151..170: every second one is a near-duplicate of the previous name. */
const SIMILAR_NAMES = { from: 150, to: 170 } as const;
/** Every 70th ticket gets a subject of 150-200 characters. */
const LONG_SUBJECT_EVERY = 70;
const FILE_MIX: Record<FileKind, number> = { png: 80, jpeg: 40, pdf: 50, txt: 30 };
const LONG_COMMENT = { minChars: 700, maxChars: 1800 } as const;
/** The default dataset's tickets are numbered from this value + 1, so the numbers are the same after every reset. */
export const TICKET_NUMBER_BASE = 1000;

export type Priority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
export type HistoryKind = 'CREATED' | 'UPDATED' | 'ASSIGNED' | 'STATUS_CHANGED';
export type FileKind = 'png' | 'jpeg' | 'pdf' | 'txt';
export type Snapshot = Record<string, unknown>;

export interface SeedUser { id: string; email: string; displayName: string; role: 'ADMIN' | 'AGENT'; createdAt: Date }
export interface SeedAgent { id: string; userId: string; displayName: string }
export interface SeedGroup { id: string; code: string; name: string; description: string }
export interface SeedMembership { id: string; agentId: string; groupId: string }
export interface SeedCustomer { id: string; name: string; email: string; company: string | null; phone: string | null; createdAt: Date }
export interface SeedTicket {
  id: string;
  index: number;
  /** A fixed ticket number (1001, 1002, ...) for the default dataset; null lets the database assign the next one. */
  number: number | null;
  subject: string;
  description: string;
  customerId: string;
  groupId: string;
  assignedAgentId: string | null;
  status: StatusCode;
  priority: Priority;
  resolution: string | null;
  unresolvedReason: string | null;
  resolvedAt: Date | null;
  unresolvedAt: Date | null;
  closedAt: Date | null;
  createdByUserId: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
export interface SeedHistory {
  id: string;
  ticketId: string;
  actorUserId: string;
  kind: HistoryKind;
  before: Snapshot | null;
  after: Snapshot;
  reason: string | null;
  createdAt: Date;
}
export interface SeedComment {
  id: string;
  ticketId: string;
  authorUserId: string;
  body: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
export interface SeedAttachment {
  id: string;
  commentId: string;
  ticketId: string;
  objectKey: string;
  originalName: string;
  contentType: 'image/png' | 'image/jpeg' | 'application/pdf' | 'text/plain';
  kind: FileKind;
  createdByUserId: string;
  createdAt: Date;
  /** The size the generator aims for; the real size is known after `build()`. */
  targetBytes: number;
  /** The file's bytes, the same on every call. */
  build: () => Buffer;
}

export interface SeedDataset {
  dataset: string;
  seed: number;
  referenceDate: Date;
  users: SeedUser[];
  agents: SeedAgent[];
  groups: SeedGroup[];
  memberships: SeedMembership[];
  customers: SeedCustomer[];
  tickets: SeedTicket[];
  history: SeedHistory[];
  comments: SeedComment[];
  attachments: SeedAttachment[];
}

export interface DatasetOptions {
  dataset?: string;
  seed?: number;
  /** "Now" of the dataset: tickets are created within the 90 days before it. Defaults to the current time. */
  referenceDate?: Date;
}

const SUBJECT_MAX = 200; // what the ticket form allows
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const pad = (n: number, width: number) => String(n).padStart(width, '0');

const typeOf: Record<FileKind, SeedAttachment['contentType']> = { png: 'image/png', jpeg: 'image/jpeg', pdf: 'application/pdf', txt: 'text/plain' };
const extensionOf: Record<FileKind, string> = { png: 'png', jpeg: 'jpg', pdf: 'pdf', txt: 'txt' };

export function generateDataset(options: DatasetOptions = {}): SeedDataset {
  const dataset = options.dataset ?? DATASET;
  const seed = options.seed ?? 42;
  const ref = options.referenceDate ?? new Date();
  const root = new Rng(seed);
  const id = (kind: string, ...parts: Array<string | number>) => seedId(dataset, kind, ...parts);
  // The default dataset has plain addresses and group codes; any other dataset (tests) gets its own, so two never collide.
  const tag = dataset === DATASET ? '' : `.${dataset}`;

  // ---- accounts, groups, memberships
  const longAgo = new Date(ref.getTime() - ACCOUNT_AGE_DAYS * DAY);
  const users: SeedUser[] = [];
  const admins = ADMIN_NAMES.map((displayName, i) => {
    const user: SeedUser = { id: id('user', 'admin', i + 1), email: `admin${i + 1}${tag}@example.test`, displayName, role: 'ADMIN', createdAt: longAgo };
    users.push(user);
    return user;
  });
  const agents: SeedAgent[] = [];
  for (let i = 0; i < SIZES.agents; i++) {
    const displayName = agentName(i);
    const user: SeedUser = { id: id('user', 'agent', i + 1), email: `agent${pad(i + 1, 2)}${tag}@example.test`, displayName, role: 'AGENT', createdAt: longAgo };
    users.push(user);
    agents.push({ id: id('agent', i + 1), userId: user.id, displayName });
  }
  const groups: SeedGroup[] = names.GROUPS.map((g) => ({
    id: id('group', g.code),
    code: tag ? `${g.code}-${dataset}` : g.code,
    name: g.name,
    description: g.description,
  }));

  // 15 primary memberships (3 per group) plus 10 second ones: 25 in total, ten agents in two groups.
  const memberships: SeedMembership[] = [];
  const membersByGroup = new Map<string, SeedAgent[]>(groups.map((g) => [g.id, []]));
  const addMembership = (agent: SeedAgent, group: SeedGroup) => {
    memberships.push({ id: id('membership', agent.id, group.id), agentId: agent.id, groupId: group.id });
    membersByGroup.get(group.id)!.push(agent);
  };
  agents.forEach((agent, i) => addMembership(agent, groups[i % groups.length]!));
  agents.slice(0, SECOND_GROUP_AGENTS).forEach((agent, i) => addMembership(agent, groups[(i + 1) % groups.length]!));
  const userOfAgent = new Map(agents.map((a) => [a.id, a.userId]));

  // ---- customers
  const cRng = root.fork('customers');
  const customers: SeedCustomer[] = [];
  for (let i = 0; i < SIZES.customers; i++) {
    const ru = cRng.chance(0.3);
    let name = ru ? `${cRng.pick(names.RU_FIRST)} ${cRng.pick(names.RU_LAST)}` : `${cRng.pick(names.EN_FIRST)} ${cRng.pick(names.EN_LAST)}`;
    if (i >= SIMILAR_NAMES.from && i < SIMILAR_NAMES.to && i % 2 === 1) {
      // Similar names on purpose: the previous customer's name with one letter dropped from the surname.
      const [first, last] = customers[i - 1]!.name.split(' ');
      name = `${first} ${last!.slice(0, 2)}${last!.slice(3)}`;
    }
    customers.push({
      id: id('customer', i + 1),
      name,
      email: `customer${pad(i + 1, 3)}${tag}@example.test`,
      company: cRng.chance(0.12) ? null : cRng.pick(names.COMPANIES),
      phone: cRng.chance(0.3) ? null : `+1 555 01${pad(cRng.int(0, 99), 2)}`,
      createdAt: new Date(ref.getTime() - cRng.int(TICKET_WINDOW_DAYS + 1, 400) * DAY),
    });
  }

  // ---- tickets, their history and comments
  const tRng = root.fork('tickets');
  const statusList = tRng.shuffle((Object.keys(STATUS_COUNTS) as StatusCode[]).flatMap((s) => Array<StatusCode>(STATUS_COUNTS[s]).fill(s)));
  const counts = commentCounts(root.fork('comment-counts'), SIZES.tickets, SIZES.comments);

  const tickets: SeedTicket[] = [];
  const history: SeedHistory[] = [];
  const comments: SeedComment[] = [];
  const cmRng = root.fork('comments');

  for (let index = 0; index < SIZES.tickets; index++) {
    const r = tRng.fork(`t${index}`);
    const finalStatus = statusList[index]!;
    const group = r.weighted(groups.map((g, i) => [g, GROUP_WEIGHTS[i]!] as const));
    const members = membersByGroup.get(group.id)!;
    const customer = r.pick(customers);
    const ru = r.chance(0.25);
    const priority = r.weighted<Priority>([['LOW', 20], ['NORMAL', 50], ['HIGH', 22], ['URGENT', 8]]);
    const creatorUser = r.chance(0.85) ? userOfAgent.get(r.pick(members).id)! : r.pick(admins).id;

    // What happens to the ticket after it is created.
    const path = statusPath(r, finalStatus);
    const assignedAtCreation = finalStatus === 'NEW' ? r.chance(0.65) : r.chance(0.6);
    const firstAssignee = r.pick(members);
    const steps: Array<{ kind: 'ASSIGNED' | 'UPDATED' | 'STATUS_CHANGED'; to?: StatusCode }> = [];
    if (!assignedAtCreation && finalStatus !== 'NEW') steps.push({ kind: 'ASSIGNED' });
    if (r.chance(0.08)) steps.push({ kind: 'UPDATED' });
    path.forEach((to, k) => {
      steps.push({ kind: 'STATUS_CHANGED', to });
      if (k === 0 && finalStatus === 'IN_PROGRESS' && members.length > 1 && r.chance(0.1)) steps.push({ kind: 'ASSIGNED' }); // handed over mid-way
    });

    // Times: created within the window, then the steps spread over what is left, at least a minute apart.
    const need = (steps.length + 3) * 2 * MINUTE;
    const createdAtMs = Math.min(ref.getTime() - r.int(10 * MINUTE, TICKET_WINDOW_DAYS * DAY), ref.getTime() - need);
    const stepTimes = spread(r, createdAtMs, ref.getTime() - 2 * MINUTE, steps.length);

    let state = {
      subject: subjectFor(r, ru, index),
      description: describe(r, ru),
      priority,
      groupId: group.id,
      assignedAgentId: assignedAtCreation ? firstAssignee.id : (null as string | null),
      status: 'NEW' as StatusCode,
      resolution: null as string | null,
      unresolvedReason: null as string | null,
      resolvedAt: null as Date | null,
      unresolvedAt: null as Date | null,
      closedAt: null as Date | null,
    };
    const snap = (s: typeof state) => ticketSnapshot({ ...s, status: { code: s.status } }) as Snapshot;
    const ticketId = id('ticket', index + 1);
    const created = new Date(createdAtMs);
    history.push({ id: id('history', index + 1, 0), ticketId, actorUserId: creatorUser, kind: 'CREATED', before: null, after: snap(state), reason: null, createdAt: created });

    const frozenSpans: TimeSpan[] = []; // the periods in which the ticket was CLOSED or UNRESOLVED
    let spanStart = createdAtMs;
    let spanStatus: StatusCode = 'NEW';
    const closeSpan = (end: number) => {
      if (isFrozen(spanStatus)) frozenSpans.push({ from: spanStart, to: end });
    };
    steps.forEach((step, k) => {
      const at = new Date(stepTimes[k]!);
      const before = snap(state);
      let actor: string;
      let reason: string | null = null;
      if (step.kind === 'ASSIGNED') {
        const others = members.filter((m) => m.id !== state.assignedAgentId);
        state = { ...state, assignedAgentId: r.pick(others).id };
        actor = r.chance(0.5) ? r.pick(admins).id : userOfAgent.get(r.pick(members).id)!;
      } else if (step.kind === 'UPDATED') {
        state = { ...state, priority: r.pick((['LOW', 'NORMAL', 'HIGH', 'URGENT'] as Priority[]).filter((p) => p !== state.priority)) };
        actor = state.assignedAgentId && r.chance(0.8) ? userOfAgent.get(state.assignedAgentId)! : r.pick(admins).id;
      } else {
        const to = step.to!;
        const rule = findTransition(state.status, to);
        if (!rule) throw new Error(`seed generator built a forbidden transition ${state.status} -> ${to}`);
        if (state.assignedAgentId === null) state = { ...state, assignedAgentId: firstAssignee.id }; // work needs an assignee
        const outcome = applyOutcome(state, to, { resolution: r.pick(names.RESOLUTIONS), unresolvedReason: r.pick(names.UNRESOLVED_REASONS) }, at);
        const reopening = state.status === 'RESOLVED' || state.status === 'UNRESOLVED' || state.status === 'CLOSED';
        if (to === 'WAITING_CUSTOMER') reason = r.pick(names.WAITING_REASONS);
        else if (to === 'IN_PROGRESS' && reopening) reason = r.pick(names.REOPEN_REASONS);
        else if (r.chance(0.25)) reason = r.pick([...names.WAITING_REASONS, ...names.REOPEN_REASONS]);
        closeSpan(at.getTime());
        spanStart = at.getTime();
        spanStatus = to;
        actor = rule.adminOnly ? r.pick(admins).id : r.chance(0.1) ? r.pick(admins).id : userOfAgent.get(state.assignedAgentId!)!;
        state = { ...state, ...outcome, status: to };
      }
      history.push({ id: id('history', index + 1, k + 1), ticketId, actorUserId: actor, kind: step.kind, before, after: snap(state), reason, createdAt: at });
    });
    if (isFrozen(spanStatus)) frozenSpans.push({ from: spanStart, to: Number.POSITIVE_INFINITY });

    // Comments only in the spans in which the ticket was open for them.
    const lastEvent = steps.length > 0 ? stepTimes[steps.length - 1]! : createdAtMs;
    const windows = openWindows(createdAtMs, ref.getTime(), frozenSpans);
    const ticketComments = makeComments(cmRng.fork(`c${index}`), id, index, ticketId, counts[index]!, windows, state.assignedAgentId, members, userOfAgent, admins, ru);
    comments.push(...ticketComments);
    const lastComment = ticketComments.reduce((latest, c) => Math.max(latest, c.updatedAt.getTime()), 0);

    tickets.push({
      id: ticketId,
      index: index + 1,
      number: dataset === DATASET ? TICKET_NUMBER_BASE + index + 1 : null,
      ...state,
      customerId: customer.id,
      createdByUserId: creatorUser,
      version: 1 + steps.length,
      createdAt: created,
      updatedAt: new Date(Math.max(lastEvent, lastComment)),
    });
  }

  const attachments = makeAttachments(root.fork('attachments'), id, comments, tickets);
  // A file is added a moment after its comment, so it can be the latest thing that happened to a ticket.
  const ticketById = new Map(tickets.map((t) => [t.id, t]));
  for (const a of attachments) {
    const ticket = ticketById.get(a.ticketId)!;
    if (a.createdAt.getTime() > ticket.updatedAt.getTime()) ticket.updatedAt = a.createdAt;
  }
  return { dataset, seed, referenceDate: ref, users, agents, groups, memberships, customers, tickets, history, comments, attachments };
}

// ---------------------------------------------------------------- helpers

/** The statuses a ticket passes through after NEW on its way to `final` (each step is a permitted transition). */
function statusPath(r: Rng, final: StatusCode): StatusCode[] {
  const IP: StatusCode = 'IN_PROGRESS';
  const W: StatusCode = 'WAITING_CUSTOMER';
  const RES: StatusCode = 'RESOLVED';
  const UNR: StatusCode = 'UNRESOLVED';
  const toResolved = (): StatusCode[] => {
    const roll = r.next();
    if (roll < 0.14) return [IP, UNR, IP, RES]; // reopened from UNRESOLVED and then resolved
    if (roll < 0.24) return [IP, RES, IP, RES]; // reopened after a resolution
    if (roll < 0.5) return [IP, W, IP, RES];
    return [IP, RES];
  };
  switch (final) {
    case 'NEW':
      return [];
    case 'IN_PROGRESS': {
      const roll = r.next();
      if (roll < 0.08) return [IP, RES, IP];
      if (roll < 0.12) return [IP, UNR, IP];
      if (roll < 0.35) return [IP, W, IP];
      return [IP];
    }
    case 'WAITING_CUSTOMER':
      return r.chance(0.2) ? [IP, W, IP, W] : [IP, W];
    case 'RESOLVED':
      return toResolved();
    case 'UNRESOLVED':
      return r.chance(0.4) ? [IP, W, UNR] : [IP, UNR];
    case 'CLOSED': {
      if (r.chance(0.05)) return [IP, RES, 'CLOSED', IP, RES, 'CLOSED'];
      return [...toResolved(), 'CLOSED'];
    }
  }
}

/** `n` strictly increasing times in (from, to), at least a minute apart. */
function spread(r: Rng, from: number, to: number, n: number): number[] {
  if (n === 0) return [];
  const free = to - from - (n + 1) * MINUTE;
  if (free < 0) throw new Error('not enough time for the ticket history');
  const weights = Array.from({ length: n + 1 }, () => 0.05 + r.next());
  const total = weights.reduce((a, b) => a + b, 0);
  const times: number[] = [];
  let at = from;
  for (let k = 0; k < n; k++) {
    at += MINUTE + Math.floor((weights[k]! / total) * free);
    times.push(at);
  }
  return times;
}

/** [from, to) spans of [start, end) that do not overlap the frozen spans. */
function openWindows(start: number, end: number, frozen: TimeSpan[]): TimeSpan[] {
  const out: TimeSpan[] = [];
  let cursor = start;
  for (const span of [...frozen].sort((a, b) => a.from - b.from)) {
    if (span.from > cursor) out.push({ from: cursor, to: span.from });
    cursor = Math.max(cursor, Math.min(span.to, end));
  }
  if (cursor < end) out.push({ from: cursor, to: end });
  return out;
}

/** 0..20 comments per ticket that add up to exactly `total`. */
function commentCounts(r: Rng, tickets: number, total: number): number[] {
  const buckets: ReadonlyArray<readonly [readonly [number, number], number]> = [[[0, 0], 12], [[1, 3], 30], [[4, 8], 33], [[9, 14], 17], [[15, 20], 8]];
  const counts = Array.from({ length: tickets }, () => {
    const [min, max] = r.weighted(buckets);
    return r.int(min, max);
  });
  let sum = counts.reduce((a, b) => a + b, 0);
  while (sum !== total) {
    const at = r.int(0, tickets - 1);
    if (sum < total && counts[at]! < MAX_COMMENTS_PER_TICKET) {
      counts[at]!++;
      sum++;
    } else if (sum > total && counts[at]! > 0) {
      counts[at]!--;
      sum--;
    }
  }
  return counts;
}

/** A period of time in epoch milliseconds, [from, to). */
type TimeSpan = { from: number; to: number };

function agentName(i: number): string {
  if (i % 4 === 3) return `${names.RU_FIRST[i % names.RU_FIRST.length]} ${names.RU_LAST[(i * 5) % names.RU_LAST.length]}`;
  return `${names.EN_FIRST[i % names.EN_FIRST.length]} ${names.EN_LAST[(i * 7) % names.EN_LAST.length]}`;
}

function describe(r: Rng, ru: boolean): string {
  const { details } = names.textsFor(ru);
  return r.chance(0.7) ? `${r.pick(details)} ${r.pick(details)}` : r.pick(details);
}

function subjectFor(r: Rng, ru: boolean, index: number): string {
  const area = r.pick(names.textsFor(ru).areas);
  const problem = r.pick(names.textsFor(ru).problems);
  const base = ru ? `${area[0]!.toUpperCase()}${area.slice(1)}: ${problem}` : `Problem: ${area} ${problem}`;
  if (index % LONG_SUBJECT_EVERY !== 3) return base;
  // A deliberately long subject (up to the 200 characters the form allows).
  let long = base;
  while (long.length < 150) long += `; ${r.pick(names.textsFor(ru).problems)}`;
  return long.length <= SUBJECT_MAX ? long : long.slice(0, 197).replace(/[\s;:,]+\S*$/, '') + '...';
}

function commentBody(r: Rng, ru: boolean): string {
  const pool = ru && r.chance(0.85) ? names.RU_COMMENTS : names.EN_COMMENTS;
  if (r.chance(0.03)) {
    // A long, multi-paragraph note.
    const parts: string[] = [];
    while (parts.join('\n\n').length < LONG_COMMENT.minChars) parts.push(Array.from({ length: r.int(2, 4) }, () => r.pick(names.textsFor(ru).details)).join(' '));
    return parts.join('\n\n').slice(0, Math.min(COMMENT_MAX, LONG_COMMENT.maxChars));
  }
  return r.chance(0.35) ? `${r.pick(pool)} ${r.pick(pool)}` : r.pick(pool);
}

function makeComments(
  r: Rng,
  id: (kind: string, ...parts: Array<string | number>) => string,
  ticketIndex: number,
  ticketId: string,
  count: number,
  windows: TimeSpan[],
  assigneeId: string | null,
  members: SeedAgent[],
  userOfAgent: Map<string, string>,
  admins: SeedUser[],
  ru: boolean,
): SeedComment[] {
  if (count === 0) return [];
  // Keep clear of the edges of a window: the ticket exists for 30 s before the first comment and may be
  // frozen right after the window, so nothing happens in the last 10 s of it either.
  const usable = windows.map((w) => ({ from: w.from + 30_000, to: w.to - 10_000 })).filter((w) => w.to - w.from > 1000);
  if (usable.length === 0) return [];
  const total = usable.reduce((a, w) => a + (w.to - w.from), 0);
  const positions = Array.from({ length: count }, () => r.next() * total).sort((a, b) => a - b);
  return positions.map((pos, k) => {
    let rest = pos;
    let window = usable[usable.length - 1]!;
    for (const w of usable) {
      if (rest < w.to - w.from) {
        window = w;
        break;
      }
      rest -= w.to - w.from;
    }
    const at = Math.floor(window.from + Math.min(rest, window.to - window.from - 1));
    const author = assigneeId && r.chance(0.6) ? userOfAgent.get(assigneeId)! : r.chance(0.1) ? r.pick(admins).id : userOfAgent.get(r.pick(members).id)!;
    const edited = window.to - at > 3 * MINUTE && r.chance(0.04);
    return {
      id: id('comment', ticketIndex + 1, k + 1),
      ticketId,
      authorUserId: author,
      body: commentBody(r, ru),
      version: edited ? 2 : 1,
      createdAt: new Date(at),
      updatedAt: new Date(edited ? at + r.int(2 * MINUTE, Math.min(60 * MINUTE, window.to - at - MINUTE)) : at),
    };
  });
}

/** 200 files spread over comments (at most five per comment): PNG, JPEG, PDF and TXT. */
function makeAttachments(
  r: Rng,
  id: (kind: string, ...parts: Array<string | number>) => string,
  comments: SeedComment[],
  tickets: SeedTicket[],
): SeedAttachment[] {
  const pool = (Object.keys(FILE_MIX) as FileKind[]).flatMap((kind) => Array<FileKind>(FILE_MIX[kind]).fill(kind));
  const kinds = r.shuffle(pool).slice(0, SIZES.attachments);
  const ticketOf = new Map(tickets.map((t) => [t.id, t]));
  const attachments: SeedAttachment[] = [];
  let next = 0;
  for (const comment of r.shuffle(comments)) {
    if (next >= kinds.length) break;
    const n = Math.min(r.weighted([[1, 60], [2, 25], [3, 10], [4, 3], [5, 2]] as const), kinds.length - next);
    for (let j = 0; j < n; j++, next++) {
      const kind = kinds[next]!;
      const targetBytes = r.chance(0.9) ? r.int(2 * 1024, 50 * 1024) : r.int(50 * 1024, 120 * 1024);
      const stem = r.pick(names.ATTACHMENT_NAMES[kind]);
      const fileRng = r.fork(`file-${next}`);
      const ticket = ticketOf.get(comment.ticketId)!;
      attachments.push({
        id: id('attachment', next + 1),
        commentId: comment.id,
        ticketId: comment.ticketId,
        objectKey: `tickets/${comment.ticketId}/comments/${comment.id}/${id('object', next + 1)}`,
        originalName: `${stem}-${next + 1}.${extensionOf[kind]}`,
        contentType: typeOf[kind],
        kind,
        createdByUserId: comment.authorUserId,
        createdAt: new Date(comment.createdAt.getTime() + 1000),
        targetBytes,
        build: () => {
          const f = fileRng.fork('content');
          if (kind === 'png') return makePng(f, targetBytes);
          if (kind === 'jpeg') return makeJpeg(f, targetBytes);
          if (kind === 'pdf') return makePdf(f, targetBytes, `Ticket ${ticket.index}: ${stem}`);
          return makeText(f, targetBytes);
        },
      });
    }
  }
  if (attachments.length !== SIZES.attachments) throw new Error(`generated ${attachments.length} attachments instead of ${SIZES.attachments}`);
  return attachments;
}
