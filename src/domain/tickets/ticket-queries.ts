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

export interface Dashboard {
  total: number;
  /** null when the actor has no agent profile, so there is nothing to link to. */
  mine: { count: number; agentId: string } | null;
  unassigned: number;
  waiting: { count: number; statusId: string | null };
  unresolved: { count: number; statusId: string | null };
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

  /** A customer's tickets, restricted to the actor's scope (the customer directory itself is shared). */
  async customerTickets(actor: Actor, customerId: string, page = 1) {
    const scope = await loadScope(this.prisma, actor);
    const pageNo = Math.max(1, Math.floor(page) || 1);
    if (!uuid.safeParse(customerId).success) return { items: [], total: 0, page: pageNo, perPage: CUSTOMER_TICKETS_PAGE_SIZE };
    const where: Prisma.TicketWhereInput = { AND: [{ customerId }, ticketScopeWhere(scope)] };
    const [total, rows] = await Promise.all([
      this.prisma.ticket.count({ where }),
      this.prisma.ticket.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (pageNo - 1) * CUSTOMER_TICKETS_PAGE_SIZE,
        take: CUSTOMER_TICKETS_PAGE_SIZE,
        select: { id: true, number: true, subject: true, priority: true, updatedAt: true, status: { select: { name: true } }, group: { select: { name: true } } },
      }),
    ]);
    return {
      items: rows.map((t) => ({ id: t.id, number: t.number, subject: t.subject, priority: t.priority, status: t.status.name, group: t.group.name, updatedAt: t.updatedAt.toISOString() })),
      total,
      page: pageNo,
      perPage: CUSTOMER_TICKETS_PAGE_SIZE,
    };
  }

  /** Counts behind the saved-filter shortcuts; every count uses the same scope as the ticket list. */
  async dashboard(actor: Actor): Promise<Dashboard> {
    const scope: Scope = await loadScope(this.prisma, actor);
    const inScope = ticketScopeWhere(scope);
    const count = (extra: Prisma.TicketWhereInput) => this.prisma.ticket.count({ where: { AND: [inScope, extra] } });
    const statusId = async (code: StatusCode) => (await this.prisma.ticketStatus.findUnique({ where: { code } }))?.id ?? null;

    const [total, mine, unassigned, waitingId, unresolvedId] = await Promise.all([
      count({}),
      actor.agentId ? count({ assignedAgentId: actor.agentId }) : Promise.resolve(0),
      count({ assignedAgentId: null }),
      statusId('WAITING_CUSTOMER'),
      statusId('UNRESOLVED'),
    ]);
    const [waiting, unresolved] = await Promise.all([
      waitingId ? count({ statusId: waitingId }) : Promise.resolve(0),
      unresolvedId ? count({ statusId: unresolvedId }) : Promise.resolve(0),
    ]);
    return {
      total,
      mine: actor.agentId ? { count: mine, agentId: actor.agentId } : null,
      unassigned,
      waiting: { count: waiting, statusId: waitingId },
      unresolved: { count: unresolved, statusId: unresolvedId },
    };
  }
}
