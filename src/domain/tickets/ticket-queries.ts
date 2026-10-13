import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { loadScope } from '../db.js';
import { ForbiddenError, NotFoundError } from '../errors.js';
import { type Actor, type Scope, canAccessGroup, isAdmin, ticketScopeWhere } from '../../policies/ticket-policy.js';
import { assertBatchSize } from './schemas.js';
import { type StatusCode, STATUS_CODES, allowedTargets, findTransition, isFrozen, isStatusCode } from './workflow.js';

const uuid = z.uuid();
const HISTORY_PAGE_SIZE = 20;
const CUSTOMER_TICKETS_PAGE_SIZE = 10;

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  perPage: number;
}

export interface HistoryChange {
  field: string;
  from: string | null;
  to: string | null;
}

export interface HistoryItem {
  id: string;
  kind: string;
  createdAt: string;
  actor: string;
  reason: string | null;
  changes: HistoryChange[];
}

/** What the bulk status form needs: the selected tickets as they are now, and the changes valid for all of them. */
export interface BulkFormState {
  tickets: Array<{ id: string; number: number; subject: string; version: number; statusCode: string; statusName: string; assigned: boolean }>;
  /** Selected ids that are unknown or out of scope (not named, so existence is not disclosed). */
  unavailable: number;
  targets: Array<{ code: StatusCode; name: string; reason: 'required' | 'optional'; resolution: boolean; unresolvedReason: boolean; /** The change needs an assignee, so tickets without one would be refused. */ needsAssignee: boolean }>;
}

export interface FormState {
  ticket: {
    id: string;
    number: number;
    version: number;
    statusCode: string;
    statusName: string;
    frozen: boolean;
    groupId: string;
    groupName: string;
    groupActive: boolean;
    assigneeId: string | null;
  };
  /** Transitions this actor may attempt from the current status, with the inputs each one needs. */
  targets: Array<{
    code: StatusCode;
    name: string;
    reason: 'required' | 'optional';
    resolution: boolean;
    unresolvedReason: boolean;
    assignee: 'none' | 'set' | 'activeMember';
  }>;
  groups: Array<{ id: string; name: string }>;
  /** Active members of the selected group (the ticket's own group unless another was requested). */
  agents: Array<{ id: string; name: string }>;
}

export interface BulkAssignState {
  tickets: Array<{ id: string; number: number; subject: string; version: number; statusCode: string; statusName: string; groupName: string; assigneeName: string | null; frozen: boolean }>;
  unavailable: number;
  groups: Array<{ id: string; name: string }>;
  /** The group all selected tickets share, if they share one. */
  sharedGroupId: string | null;
  /** Active members of every group listed in `groups`. */
  agentsByGroup: Record<string, Array<{ id: string; name: string }>>;
}

export interface QueueTicket {
  id: string;
  number: number;
  subject: string;
  priority: string;
  statusCode: string;
  statusName: string;
  updatedAt: string;
}

export interface Dashboard {
  total: number;
  /** null when the actor has no agent profile, so there is nothing to link to. */
  mine: { count: number; agentId: string } | null;
  unassigned: number;
  waiting: { count: number; statusId: string | null };
  unresolved: { count: number; statusId: string | null };
  /** Open means every status but CLOSED, as in the "My open tickets" link. */
  mineOpen: number;
  /** Every ticket in the viewer's scope that is not CLOSED. */
  open: number;
  createdToday: number;
  closedToday: number;
  /** Tickets created per day over the last 14 days (UTC), oldest first. */
  incoming: Array<{ date: string; count: number }>;
  /** Open tickets per group, split by status in workflow order. */
  byGroup: Array<{ id: string; name: string; count: number; statuses: Array<{ code: string; name: string; count: number }> }>;
  /** Open tickets per agent, split by status in workflow order. */
  byAgent: Array<{ id: string; name: string; count: number; statuses: Array<{ code: string; name: string; count: number }> }>;
  /** The newest open tickets assigned to the viewer. */
  queue: QueueTicket[];
}

const TRACKED_FIELDS: Array<[key: string, label: string]> = [
  ['subject', 'Subject'],
  ['description', 'Description'],
  ['priority', 'Priority'],
  ['status', 'Status'],
  ['groupId', 'Group'],
  ['assignedAgentId', 'Assignee'],
  ['resolution', 'Resolution'],
  ['unresolvedReason', 'Unresolved reason'],
];

const truncate = (v: string, max = 120) => (v.length > max ? `${v.slice(0, max)}…` : v);

/**
 * Read models for the admin UI. Every method applies the actor's scope itself, in the same way as
 * the ticket list: a ticket outside the scope behaves as if it did not exist.
 */
export class TicketQueries {
  constructor(private readonly prisma: PrismaClient) {}

  private async accessibleTicket(actor: Actor, ticketId: string) {
    const scope = await loadScope(this.prisma, actor);
    if (!uuid.safeParse(ticketId).success) throw new NotFoundError('ticket');
    const ticket = await this.prisma.ticket.findFirst({
      where: { AND: [{ id: ticketId }, ticketScopeWhere(scope)] },
      include: { status: true, group: true },
    });
    if (!ticket) throw new NotFoundError('ticket');
    return { ticket, scope };
  }

  /** Everything the Assign and Change status forms need in one round trip. */
  async formState(actor: Actor, ticketId: string, requestedGroupId?: string): Promise<FormState> {
    const { ticket, scope } = await this.accessibleTicket(actor, ticketId);
    if (requestedGroupId !== undefined) {
      if (!uuid.safeParse(requestedGroupId).success) throw new NotFoundError('group');
      if (!canAccessGroup(scope, requestedGroupId)) throw new ForbiddenError('group_not_allowed', 'Group is not available to you');
    }
    const code = ticket.status.code;
    if (!isStatusCode(code)) throw new Error(`Ticket ${ticket.id} has unknown status ${code}`);

    const statusRows = await this.prisma.ticketStatus.findMany({ where: { code: { in: [...STATUS_CODES] } } });
    const names = new Map(statusRows.map((s) => [s.code, s.name]));
    const offered = new Set(statusRows.filter((s) => s.isActive).map((s) => s.code));

    const targets = allowedTargets(code, isAdmin(actor)).filter((to) => offered.has(to)).map((to) => {
      const rule = findTransition(code, to)!;
      return {
        code: to,
        name: names.get(to) ?? to,
        reason: rule.reason,
        resolution: rule.resolution,
        unresolvedReason: rule.unresolvedReason,
        assignee: rule.assignee,
      };
    });

    const groups = await this.prisma.supportGroup.findMany({
      where: { isActive: true, ...(scope.all ? {} : { id: { in: [...scope.groupIds] } }) },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    const agents = await this.prisma.agent.findMany({
      where: { isActive: true, groups: { some: { groupId: requestedGroupId ?? ticket.groupId } } },
      select: { id: true, displayName: true },
      orderBy: { displayName: 'asc' },
    });

    return {
      ticket: {
        id: ticket.id,
        number: ticket.number,
        version: ticket.version,
        statusCode: code,
        statusName: ticket.status.name,
        frozen: isFrozen(code),
        groupId: ticket.groupId,
        groupName: ticket.group.name,
        groupActive: ticket.group.isActive,
        assigneeId: ticket.assignedAgentId,
      },
      targets,
      groups,
      agents: agents.map((a) => ({ id: a.id, name: a.displayName })),
    };
  }

  /**
   * The selected tickets with their current versions (the form sends them back so concurrent edits are
   * detected) and the target statuses this actor may apply to every one of them. Whatever the form offers,
   * the service checks each ticket again.
   */
  async bulkFormState(actor: Actor, ticketIds: string[]): Promise<BulkFormState> {
    const distinct = [...new Set(ticketIds)];
    assertBatchSize(distinct.length);
    const valid = distinct.filter((id) => uuid.safeParse(id).success);
    const scope = await loadScope(this.prisma, actor);
    const rows = await this.prisma.ticket.findMany({
      where: { AND: [{ id: { in: valid } }, ticketScopeWhere(scope)] },
      include: { status: true },
      orderBy: { number: 'asc' },
    });

    const codes = [...new Set(rows.map((r) => r.status.code))].filter(isStatusCode);
    const statusRows = await this.prisma.ticketStatus.findMany({ where: { code: { in: [...STATUS_CODES] } } });
    const names = new Map(statusRows.map((s) => [s.code, s.name]));
    const offered = new Set(statusRows.filter((s) => s.isActive).map((s) => s.code));
    const common = codes.length === 0 ? [] : codes.map((c) => allowedTargets(c, isAdmin(actor))).reduce((a, b) => a.filter((t) => b.includes(t)));

    return {
      tickets: rows.map((r) => ({ id: r.id, number: r.number, subject: r.subject, version: r.version, statusCode: r.status.code, statusName: r.status.name, assigned: r.assignedAgentId !== null })),
      unavailable: new Set(ticketIds).size - rows.length,
      targets: common
        .filter((to) => offered.has(to))
        .map((to) => {
          const rules = codes.map((c) => findTransition(c, to)!);
          return {
            code: to,
            name: names.get(to) ?? to,
            reason: rules.some((r) => r.reason === 'required') ? ('required' as const) : ('optional' as const),
            resolution: rules.some((r) => r.resolution),
            unresolvedReason: rules.some((r) => r.unresolvedReason),
            needsAssignee: rules.some((r) => r.assignee !== 'none'),
          };
        }),
    };
  }

  /** Newest first. Ids are resolved to names so the UI shows "Billing -> Platform", not UUIDs. */
  async history(actor: Actor, ticketId: string, page = 1): Promise<Page<HistoryItem>> {
    const { ticket } = await this.accessibleTicket(actor, ticketId);
    const pageNo = Math.max(1, Math.floor(page) || 1);
    const [total, rows] = await Promise.all([
      this.prisma.ticketHistory.count({ where: { ticketId: ticket.id } }),
      this.prisma.ticketHistory.findMany({
        where: { ticketId: ticket.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (pageNo - 1) * HISTORY_PAGE_SIZE,
        take: HISTORY_PAGE_SIZE,
        include: { actor: { select: { displayName: true } } },
      }),
    ]);

    const snapshots = rows
      .flatMap((r) => [r.before, r.after] as unknown[])
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && !Array.isArray(s));
    const ids = (key: string) => [...new Set(snapshots.map((s) => s[key]).filter((v): v is string => typeof v === 'string'))];
    const [groups, agents, statuses] = await Promise.all([
      this.prisma.supportGroup.findMany({ where: { id: { in: ids('groupId') } }, select: { id: true, name: true } }),
      this.prisma.agent.findMany({ where: { id: { in: ids('assignedAgentId') } }, select: { id: true, displayName: true } }),
      this.prisma.ticketStatus.findMany({ select: { code: true, name: true } }),
    ]);
    const lookup: Record<string, Map<string, string>> = {
      groupId: new Map(groups.map((g) => [g.id, g.name])),
      assignedAgentId: new Map(agents.map((a) => [a.id, a.displayName])),
      status: new Map(statuses.map((s) => [s.code, s.name])),
    };
    const show = (key: string, value: unknown): string | null => {
      if (value === null || value === undefined || value === '') return null;
      const text = String(value);
      return truncate(lookup[key]?.get(text) ?? text);
    };

    const items = rows.map((row): HistoryItem => {
      const before = (row.before ?? {}) as Record<string, unknown>;
      const after = (row.after ?? {}) as Record<string, unknown>;
      const changes: HistoryChange[] = [];
      if (row.kind !== 'CREATED') {
        for (const [key, label] of TRACKED_FIELDS) {
          if (before[key] !== after[key]) changes.push({ field: label, from: show(key, before[key]), to: show(key, after[key]) });
        }
      }
      return { id: row.id, kind: row.kind, createdAt: row.createdAt.toISOString(), actor: row.actor.displayName, reason: row.reason, changes };
    });
    return { items, total, page: pageNo, perPage: HISTORY_PAGE_SIZE };
  }

  /**
   * A customer's tickets, restricted to the actor's scope (the customer directory itself is shared).
   * Sorting is by a fixed set of columns (anything else falls back to the default); status sorts in workflow
   * order and priority from LOW to URGENT.
   */
  async customerTickets(actor: Actor, customerId: string, page = 1, sortBy?: string, direction?: string) {
    const scope = await loadScope(this.prisma, actor);
    const pageNo = Math.max(1, Math.floor(page) || 1);
    if (!uuid.safeParse(customerId).success) return { items: [], total: 0, page: pageNo, perPage: CUSTOMER_TICKETS_PAGE_SIZE };
    const where: Prisma.TicketWhereInput = { AND: [{ customerId }, ticketScopeWhere(scope)] };
    const [total, rows] = await Promise.all([
      this.prisma.ticket.count({ where }),
      this.prisma.ticket.findMany({
        where,
        orderBy: [customerTicketsOrder(sortBy, direction === 'asc' ? 'asc' : 'desc'), { id: 'desc' }],
        skip: (pageNo - 1) * CUSTOMER_TICKETS_PAGE_SIZE,
        take: CUSTOMER_TICKETS_PAGE_SIZE,
        select: { id: true, number: true, subject: true, priority: true, updatedAt: true, status: { select: { name: true, code: true } }, group: { select: { name: true } } },
      }),
    ]);
    return {
      items: rows.map((t) => ({ id: t.id, number: t.number, subject: t.subject, priority: t.priority, status: t.status.name, statusCode: t.status.code, group: t.group.name, updatedAt: t.updatedAt.toISOString() })),
      total,
      page: pageNo,
      perPage: CUSTOMER_TICKETS_PAGE_SIZE,
    };
  }

  /** Counts behind the saved-filter shortcuts; every count uses the same scope as the ticket list. */
  async dashboard(actor: Actor): Promise<Dashboard> {
    const scope: Scope = await loadScope(this.prisma, actor);
    const inScope = ticketScopeWhere(scope);
    const where = (extra: Prisma.TicketWhereInput): Prisma.TicketWhereInput => ({ AND: [inScope, extra] });
    const count = (extra: Prisma.TicketWhereInput) => this.prisma.ticket.count({ where: where(extra) });
    const statusId = async (code: StatusCode) => (await this.prisma.ticketStatus.findUnique({ where: { code } }))?.id ?? null;
    const notClosed: Prisma.TicketWhereInput = { status: { code: { not: 'CLOSED' } } };
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const since = new Date(dayStart.getTime() - 13 * 86_400_000);

    const [total, open, mine, unassigned, waitingId, unresolvedId, mineOpen, createdToday, closedToday] = await Promise.all([
      count({}),
      count(notClosed),
      actor.agentId ? count({ assignedAgentId: actor.agentId }) : Promise.resolve(0),
      count({ assignedAgentId: null }),
      statusId('WAITING_CUSTOMER'),
      statusId('UNRESOLVED'),
      actor.agentId ? count({ assignedAgentId: actor.agentId, ...notClosed }) : Promise.resolve(0),
      count({ createdAt: { gte: dayStart } }),
      count({ closedAt: { gte: dayStart } }),
    ]);
    const [waiting, unresolved] = await Promise.all([
      waitingId ? count({ statusId: waitingId }) : Promise.resolve(0),
      unresolvedId ? count({ statusId: unresolvedId }) : Promise.resolve(0),
    ]);

    const [recent, groupRows, agentRows, queueRows] = await Promise.all([
      this.prisma.ticket.findMany({ where: where({ createdAt: { gte: since } }), select: { createdAt: true } }),
      this.prisma.ticket.groupBy({ by: ['groupId', 'statusId'], where: where(notClosed), _count: { _all: true } }),
      this.prisma.ticket.groupBy({ by: ['assignedAgentId', 'statusId'], where: where({ ...notClosed, assignedAgentId: { not: null } }), _count: { _all: true } }),
      actor.agentId
        ? this.prisma.ticket.findMany({
            where: where({ assignedAgentId: actor.agentId, ...notClosed }),
            orderBy: { updatedAt: 'desc' },
            take: 8,
            select: { id: true, number: true, subject: true, priority: true, updatedAt: true, status: { select: { code: true, name: true } } },
          })
        : Promise.resolve([]),
    ]);

    const perDay = new Map<string, number>();
    for (let i = 0; i < 14; i++) perDay.set(new Date(since.getTime() + i * 86_400_000).toISOString().slice(0, 10), 0);
    for (const row of recent) {
      const key = row.createdAt.toISOString().slice(0, 10);
      if (perDay.has(key)) perDay.set(key, (perDay.get(key) ?? 0) + 1);
    }
    const agentIds = agentRows.flatMap((a) => (a.assignedAgentId ? [a.assignedAgentId] : []));
    const [groups, agents, statusRows] = await Promise.all([
      this.prisma.supportGroup.findMany({ where: { id: { in: [...new Set(groupRows.map((g) => g.groupId))] } }, select: { id: true, name: true } }),
      this.prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, displayName: true } }),
      this.prisma.ticketStatus.findMany({ select: { id: true, code: true, name: true, sortOrder: true }, orderBy: { sortOrder: 'asc' } }),
    ]);
    const groupName = new Map(groups.map((g) => [g.id, g.name]));
    /** Counts per status in workflow order, without the empty ones. */
    const splitByStatus = (parts: Array<{ statusId: string; _count: { _all: number } }>) =>
      statusRows.flatMap((st) => {
        const n = parts.filter((r) => r.statusId === st.id).reduce((sum, r) => sum + r._count._all, 0);
        return n > 0 ? [{ code: st.code, name: st.name, count: n }] : [];
      });
    const agentName = new Map(agents.map((a) => [a.id, a.displayName]));

    return {
      total,
      mine: actor.agentId ? { count: mine, agentId: actor.agentId } : null,
      unassigned,
      waiting: { count: waiting, statusId: waitingId },
      unresolved: { count: unresolved, statusId: unresolvedId },
      mineOpen,
      open,
      createdToday,
      closedToday,
      incoming: [...perDay].map(([date, n]) => ({ date, count: n })),
      byGroup: [...new Set(groupRows.map((g) => g.groupId))]
        .map((id) => {
          const parts = groupRows.filter((r) => r.groupId === id);
          return { id, name: groupName.get(id) ?? id, count: parts.reduce((sum, r) => sum + r._count._all, 0), statuses: splitByStatus(parts) };
        })
        .sort((a, b) => b.count - a.count),
      byAgent: [...new Set(agentIds)]
        .map((id) => {
          const parts = agentRows.filter((r) => r.assignedAgentId === id);
          return {
            id,
            name: agentName.get(id) ?? id,
            count: parts.reduce((sum, r) => sum + r._count._all, 0),
            statuses: splitByStatus(parts),
          };
        })
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
      queue: queueRows.map((t) => ({ id: t.id, number: t.number, subject: t.subject, priority: t.priority, statusCode: t.status.code, statusName: t.status.name, updatedAt: t.updatedAt.toISOString() })),
    };
  }

  /** The selected tickets, the groups the actor may use and the active members of each group, for the bulk assign forms. */
  async bulkAssignState(actor: Actor, ticketIds: string[]): Promise<BulkAssignState> {
    const distinct = [...new Set(ticketIds)];
    assertBatchSize(distinct.length);
    const valid = distinct.filter((id) => uuid.safeParse(id).success);
    const scope = await loadScope(this.prisma, actor);
    const rows = await this.prisma.ticket.findMany({
      where: { AND: [{ id: { in: valid } }, ticketScopeWhere(scope)] },
      include: { status: true, group: true, assignedAgent: true },
      orderBy: { number: 'asc' },
    });
    const groups = await this.prisma.supportGroup.findMany({
      where: { isActive: true, ...(scope.all ? {} : { id: { in: [...scope.groupIds] } }) },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    const members = await this.prisma.agent.findMany({
      where: { isActive: true, groups: { some: { groupId: { in: groups.map((g) => g.id) } } } },
      select: { id: true, displayName: true, groups: { select: { groupId: true } } },
      orderBy: { displayName: 'asc' },
    });
    const agentsByGroup: Record<string, Array<{ id: string; name: string }>> = Object.fromEntries(groups.map((g) => [g.id, []]));
    for (const agent of members) {
      for (const { groupId } of agent.groups) agentsByGroup[groupId]?.push({ id: agent.id, name: agent.displayName });
    }
    const shared = new Set(rows.map((r) => r.groupId));
    return {
      tickets: rows.map((r) => ({
        id: r.id,
        number: r.number,
        subject: r.subject,
        version: r.version,
        statusCode: r.status.code,
        statusName: r.status.name,
        groupName: r.group.name,
        assigneeName: r.assignedAgent?.displayName ?? null,
        frozen: isStatusCode(r.status.code) && isFrozen(r.status.code),
      })),
      unavailable: new Set(ticketIds).size - rows.length,
      groups,
      sharedGroupId: shared.size === 1 ? [...shared][0]! : null,
      agentsByGroup,
    };
  }

  /** The group of the customer's most recent ticket that the actor can see and use, to suggest it on the new ticket form. */
  async suggestGroup(actor: Actor, customerId: string): Promise<string | null> {
    if (!uuid.safeParse(customerId).success) return null;
    const scope = await loadScope(this.prisma, actor);
    const last = await this.prisma.ticket.findFirst({
      where: { AND: [{ customerId }, ticketScopeWhere(scope), { group: { isActive: true } }] },
      orderBy: { createdAt: 'desc' },
      select: { groupId: true },
    });
    return last && canAccessGroup(scope, last.groupId) ? last.groupId : null;
  }

  /** Every history entry of a ticket, oldest first, for the activity timeline. */
  async historyAll(actor: Actor, ticketId: string): Promise<HistoryItem[]> {
    const items: HistoryItem[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.history(actor, ticketId, page);
      items.push(...batch.items);
      if (items.length >= batch.total || batch.items.length === 0) break;
    }
    return items.reverse();
  }
}

const CUSTOMER_TICKET_ORDER: Record<string, (dir: Prisma.SortOrder) => Prisma.TicketOrderByWithRelationInput> = {
  number: (dir) => ({ number: dir }),
  subject: (dir) => ({ subject: dir }),
  group: (dir) => ({ group: { name: dir } }),
  status: (dir) => ({ status: { sortOrder: dir } }),
  priority: (dir) => ({ priority: dir }),
  updatedAt: (dir) => ({ updatedAt: dir }),
};

function customerTicketsOrder(sortBy: string | undefined, dir: Prisma.SortOrder): Prisma.TicketOrderByWithRelationInput {
  const make = sortBy && Object.hasOwn(CUSTOMER_TICKET_ORDER, sortBy) ? CUSTOMER_TICKET_ORDER[sortBy] : undefined;
  return make ? make(dir) : { updatedAt: 'desc' };
}
