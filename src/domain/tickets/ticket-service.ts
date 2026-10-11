import type { Prisma, PrismaClient, Ticket, TicketStatus } from '@prisma/client';
import { z } from 'zod';
import { isRecordNotFound, lockAgent, lockGroup, lockStatus, loadScope, type Tx } from '../db.js';
import { type BulkFailure, BulkRejectedError, ConflictError, DomainError, ForbiddenError, NotFoundError, ValidationError } from '../errors.js';
import { type Actor, type Scope, canAccessGroup, isAdmin, ticketScopeWhere } from '../../policies/ticket-policy.js';
import {
  assignTicketSchema,
  assertBatchSize,
  bulkChangeStatusSchema,
  changeStatusSchema,
  createTicketSchema,
  parseInput,
  updateTicketSchema,
  versionSchema,
} from './schemas.js';
import { type StatusCode, applyOutcome, findTransition, isFrozen, isStatusCode, STATUS_CODES } from './workflow.js';

export type TicketWithStatus = Ticket & { status: TicketStatus };

type HistoryKind = 'CREATED' | 'UPDATED' | 'ASSIGNED' | 'STATUS_CHANGED';

const uuid = z.uuid();

/** A bulk change runs about eight queries per ticket in one transaction; the default 5 s is far too short for 100 tickets. */
const BULK_TRANSACTION_TIMEOUT_MS = 30_000;
const BULK_TRANSACTION_MAX_WAIT_MS = 5_000;

export interface BulkChanged {
  id: string;
  number: number;
  status: string;
}

/** What a bulk change looks up once instead of once per ticket. Its presence means the target status is locked and active. */
interface BulkPrepared {
  statusIds: Record<StatusCode, string>;
}

/** Dates become ISO strings so snapshots are plain JSON. */
function snapshot(t: TicketWithStatus): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify({
      subject: t.subject,
      description: t.description,
      priority: t.priority,
      status: t.status.code,
      groupId: t.groupId,
      assignedAgentId: t.assignedAgentId,
      resolution: t.resolution,
      unresolvedReason: t.unresolvedReason,
      resolvedAt: t.resolvedAt,
      unresolvedAt: t.unresolvedAt,
      closedAt: t.closedAt,
    }),
  ) as Prisma.InputJsonValue;
}

/**
 * Business operations on tickets. Every method checks scope and role itself (hiding a button is not
 * authorization) and runs in one transaction: ticket change, version increment and history entry
 * either all happen or none do. Concurrent edits are detected by the `version` column.
 */
export class TicketService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Out-of-scope and unknown ids look the same: 404 without disclosing existence. */
  async get(actor: Actor, ticketId: string): Promise<TicketWithStatus> {
    return this.prisma.$transaction(async (tx) => this.loadForActor(tx, await loadScope(tx, actor), ticketId));
  }

  async create(actor: Actor, input: unknown): Promise<TicketWithStatus> {
    const data = parseInput(createTicketSchema, input);
    return this.prisma.$transaction(async (tx) => {
      const scope = await loadScope(tx, actor);
      if (!canAccessGroup(scope, data.groupId)) throw new ForbiddenError('group_not_allowed', 'Group is not available to you');
      const customer = await tx.customer.findUnique({ where: { id: data.customerId } });
      if (!customer?.isActive) throw new ValidationError('validation', 'Invalid input', { customerId: 'customer is unknown or inactive' });
      if (data.assignedAgentId) await this.assertAssignable(tx, data.assignedAgentId, data.groupId);
      else await this.assertGroupActive(tx, data.groupId);

      const statuses = await this.statusIds(tx);
      const created = await tx.ticket.create({
        data: {
          subject: data.subject,
          description: data.description,
          customerId: data.customerId,
          groupId: data.groupId,
          priority: data.priority,
          assignedAgentId: data.assignedAgentId ?? null,
          statusId: statuses.NEW,
          createdByUserId: actor.userId,
        },
        include: { status: true },
      });
      await this.addHistory(tx, created.id, actor, 'CREATED', null, snapshot(created), null);
      return created;
    });
  }

  /** Ordinary edits (subject, description, priority). Not for status or assignment. */
  async update(actor: Actor, ticketId: string, expectedVersion: number, input: unknown): Promise<TicketWithStatus> {
    const data = parseInput(updateTicketSchema, input);
    const version = parseInput(versionSchema, expectedVersion);
    return this.prisma.$transaction(async (tx) => {
      const ticket = await this.loadForActor(tx, await loadScope(tx, actor), ticketId);
      this.assertVersion(ticket, version);
      this.assertNotFrozen(ticket);
      await this.assertGroupActive(tx, ticket.groupId);

      const changes: Prisma.TicketUpdateManyMutationInput = {};
      if (data.subject !== undefined && data.subject !== ticket.subject) changes.subject = data.subject;
      if (data.description !== undefined && data.description !== ticket.description) changes.description = data.description;
      if (data.priority !== undefined && data.priority !== ticket.priority) changes.priority = data.priority;
      if (Object.keys(changes).length === 0) throw new ValidationError('no_change', 'Nothing to change');

      const updated = await this.bump(tx, ticket, version, changes);
      await this.addHistory(tx, ticket.id, actor, 'UPDATED', snapshot(ticket), snapshot(updated), null);
      return updated;
    });
  }

  /**
   * Group and assignee change. A new assignee must be an active member of the (new) active group.
   * The assignee may be cleared only on NEW tickets; otherwise a valid agent is required.
   */
  async assign(actor: Actor, ticketId: string, expectedVersion: number, input: unknown): Promise<TicketWithStatus> {
    const data = parseInput(assignTicketSchema, input);
    const version = parseInput(versionSchema, expectedVersion);
    return this.prisma.$transaction(async (tx) => {
      const scope = await loadScope(tx, actor);
      const ticket = await this.loadForActor(tx, scope, ticketId);
      this.assertVersion(ticket, version);
      this.assertNotFrozen(ticket);

      const groupId = data.groupId ?? ticket.groupId;
      if (!canAccessGroup(scope, groupId)) throw new ForbiddenError('group_not_allowed', 'Group is not available to you');
      const assignee = data.assignedAgentId === undefined ? ticket.assignedAgentId : data.assignedAgentId;

      if (assignee === null) {
        if (ticket.status.code !== 'NEW') {
          throw new ValidationError('validation', 'Invalid input', { assignedAgentId: 'only NEW tickets may be unassigned' });
        }
        await this.assertGroupActive(tx, groupId);
      } else {
        await this.assertAssignable(tx, assignee, groupId);
      }
      if (groupId === ticket.groupId && assignee === ticket.assignedAgentId) {
        throw new ValidationError('no_change', 'Nothing to change');
      }

      const updated = await this.bump(tx, ticket, version, { group: { connect: { id: groupId } }, assignedAgent: assignee ? { connect: { id: assignee } } : { disconnect: true } });
      await this.addHistory(tx, ticket.id, actor, 'ASSIGNED', snapshot(ticket), snapshot(updated), null);
      return updated;
    });
  }

  async changeStatus(actor: Actor, ticketId: string, expectedVersion: number, input: unknown): Promise<TicketWithStatus> {
    return this.prisma.$transaction(async (tx) => {
      const scope = await loadScope(tx, actor);
      return this.changeStatusInTx(tx, actor, scope, ticketId, expectedVersion, input);
    });
  }

  /**
   * One status change for up to BULK_MAX_TICKETS tickets, all or nothing. Every ticket goes through the same
   * rules as a single change (scope, version, workflow, outcome fields, history). The whole batch is tried so
   * the operator sees every refused ticket at once; any refusal rolls everything back.
   */
  async bulkChangeStatus(actor: Actor, input: unknown): Promise<{ changed: BulkChanged[] }> {
    // Duplicates are merged first, then the size is checked: both before the database is touched.
    const raw = (input ?? {}) as { items?: unknown };
    if (Array.isArray(raw.items)) {
      const ids = raw.items.map((item, at) => (typeof (item as { id?: unknown } | null)?.id === 'string' ? (item as { id: string }).id : `#${at}`));
      assertBatchSize(new Set(ids).size);
    }
    const data = parseInput(bulkChangeStatusSchema, input);
    if (data.targetStatus === 'UNRESOLVED' && data.confirmSharedReason !== true) {
      throw new ValidationError('validation', 'Invalid input', { confirmSharedReason: 'confirm that this reason is appropriate for every selected ticket' });
    }

    const versions = new Map<string, number>();
    for (const item of data.items) {
      const seen = versions.get(item.id);
      if (seen !== undefined && seen !== item.version) {
        throw new ValidationError('validation', 'Invalid input', { items: `ticket ${item.id} is listed twice with different versions` });
      }
      versions.set(item.id, item.version);
    }
    const { items: _items, confirmSharedReason: _confirmed, ...change } = data;
    const ids = [...versions.keys()].sort(); // one fixed order, so two overlapping batches cannot deadlock

    return this.prisma.$transaction(
      async (tx) => {
        const scope = await loadScope(tx, actor);
        const visible = await tx.ticket.findMany({ where: { AND: [{ id: { in: ids } }, ticketScopeWhere(scope)] }, select: { id: true, number: true } });
        const numbers = new Map(visible.map((t) => [t.id, t.number]));

        // Looked up and locked once for the batch instead of once per ticket.
        const statusIds = await this.statusIds(tx);
        const target = await lockStatus(tx, statusIds[data.targetStatus], 'share');
        if (!target?.isActive) {
          throw new ValidationError('validation', 'Invalid input', { targetStatus: 'this status has been deactivated by an administrator' });
        }
        const prepared: BulkPrepared = { statusIds };

        const failures: BulkFailure[] = [];
        const changed: BulkChanged[] = [];
        for (const id of ids) {
          try {
            const updated = await this.changeStatusInTx(tx, actor, scope, id, versions.get(id)!, change, prepared);
            changed.push({ id, number: updated.number, status: updated.status.code });
          } catch (err) {
            if (!(err instanceof DomainError)) throw err; // unexpected: roll back and surface as a server error
            failures.push({ ticketId: id, number: numbers.get(id) ?? null, code: err.code, message: err.message });
          }
        }
        if (failures.length > 0) throw new BulkRejectedError(failures); // rolls the whole transaction back
        return { changed };
      },
      { timeout: BULK_TRANSACTION_TIMEOUT_MS, maxWait: BULK_TRANSACTION_MAX_WAIT_MS },
    );
  }

  /** Shared by changeStatus and the all-or-nothing bulk action. */
  async changeStatusInTx(
    tx: Tx,
    actor: Actor,
    scope: Scope,
    ticketId: string,
    expectedVersion: number,
    input: unknown,
    prepared?: BulkPrepared,
  ): Promise<TicketWithStatus> {
    const data = parseInput(changeStatusSchema, input);
    const version = parseInput(versionSchema, expectedVersion);
    const ticket = await this.loadForActor(tx, scope, ticketId);
    this.assertVersion(ticket, version);

    const from = ticket.status.code;
    if (!isStatusCode(from)) throw new Error(`Ticket ${ticket.id} has unknown status ${from}`);
    const rule = findTransition(from, data.targetStatus);
    if (!rule) throw new ValidationError('invalid_transition', `Transition ${from} -> ${data.targetStatus} is not allowed`);
    if (rule.adminOnly && !isAdmin(actor)) throw new ForbiddenError('admin_only', 'Only an administrator may perform this transition');

    // Outcome fields are accepted only for the matching target status.
    const problems: Record<string, string> = {};
    if (rule.reason === 'required' && !data.reason) problems.reason = 'a reason is required';
    if (rule.resolution && !data.resolution) problems.resolution = 'a resolution is required';
    if (!rule.resolution && data.resolution !== undefined) problems.resolution = 'only valid when resolving';
    if (rule.unresolvedReason && !data.unresolvedReason) problems.unresolvedReason = 'a reason is required';
    if (!rule.unresolvedReason && data.unresolvedReason !== undefined) problems.unresolvedReason = 'only valid when marking unresolved';
    const reassigning = data.groupId !== undefined || data.assignedAgentId !== undefined;
    if (reassigning && rule.assignee === 'none') problems.assignedAgentId = 'reassignment is not applicable to this transition';
    if (Object.keys(problems).length > 0) throw new ValidationError('validation', 'Invalid input', problems);

    const groupId = data.groupId ?? ticket.groupId;
    const assignee = data.assignedAgentId ?? ticket.assignedAgentId;
    if (rule.assignee !== 'none') {
      if (!canAccessGroup(scope, groupId)) throw new ForbiddenError('group_not_allowed', 'Group is not available to you');
      if (!assignee) throw new ValidationError('validation', 'Invalid input', { assignedAgentId: 'an assignee is required' });
      // Reopening and starting work need an active member of an active group; reassignment is validated too.
      if (rule.assignee === 'activeMember' || reassigning) await this.assertAssignable(tx, assignee, groupId);
    }

    const outcome = applyOutcome(ticket, data.targetStatus, data, this.now());
    const statuses = prepared?.statusIds ?? (await this.statusIds(tx));
    if (!prepared) {
      // SHARE lock: deactivating a status takes an UPDATE lock and then counts tickets, so one of us waits.
      const targetStatus = await lockStatus(tx, statuses[data.targetStatus], 'share');
      if (!targetStatus?.isActive) {
        throw new ValidationError('validation', 'Invalid input', { targetStatus: 'this status has been deactivated by an administrator' });
      }
    }
    const updated = await this.bump(tx, ticket, version, {
      status: { connect: { id: statuses[data.targetStatus] } },
      ...outcome,
      ...(rule.assignee !== 'none'
        ? { group: { connect: { id: groupId } }, assignedAgent: { connect: { id: assignee! } } }
        : {}),
    });
    await this.addHistory(tx, ticket.id, { userId: actor.userId }, 'STATUS_CHANGED', snapshot(ticket), snapshot(updated), data.reason ?? null);
    return updated;
  }

  // ---- helpers

  private async loadForActor(tx: Tx, scope: Scope, ticketId: string): Promise<TicketWithStatus> {
    if (!uuid.safeParse(ticketId).success) throw new NotFoundError('ticket');
    const ticket = await tx.ticket.findFirst({
      where: { AND: [{ id: ticketId }, ticketScopeWhere(scope)] },
      include: { status: true },
    });
    if (!ticket) throw new NotFoundError('ticket');
    return ticket;
  }

  private assertVersion(ticket: Ticket, expected: number): void {
    if (ticket.version !== expected) {
      throw new ConflictError('version_conflict', 'The ticket was changed by someone else. Refresh and try again.');
    }
  }

  private assertNotFrozen(ticket: TicketWithStatus): void {
    if (isFrozen(ticket.status.code as StatusCode)) {
      throw new ConflictError('ticket_frozen', 'CLOSED and UNRESOLVED tickets must be reopened first');
    }
  }

  private async assertGroupActive(tx: Tx, groupId: string): Promise<void> {
    const group = await lockGroup(tx, groupId, 'share');
    if (!group?.isActive) throw new ValidationError('validation', 'Invalid input', { groupId: 'group is unknown or inactive' });
  }

  /** Active agent, member of the active group. Locks group then agent (always this order). */
  private async assertAssignable(tx: Tx, agentId: string, groupId: string): Promise<void> {
    await this.assertGroupActive(tx, groupId);
    const agent = await lockAgent(tx, agentId, 'share');
    if (!agent?.isActive) throw new ValidationError('validation', 'Invalid input', { assignedAgentId: 'agent is unknown or inactive' });
    const member = await tx.agentGroup.findUnique({ where: { agentId_groupId: { agentId, groupId } } });
    if (!member) throw new ValidationError('validation', 'Invalid input', { assignedAgentId: 'agent is not a member of the group' });
  }

  private async statusIds(tx: Tx): Promise<Record<StatusCode, string>> {
    const rows = await tx.ticketStatus.findMany({ where: { code: { in: [...STATUS_CODES] } } });
    const byCode = new Map(rows.map((r) => [r.code, r.id]));
    const result = {} as Record<StatusCode, string>;
    for (const code of STATUS_CODES) {
      const id = byCode.get(code);
      if (!id) throw new Error(`System status ${code} is missing; run seed:reference`);
      result[code] = id;
    }
    return result;
  }

  /** Optimistic lock: the write only matches the version the caller saw. */
  private async bump(tx: Tx, ticket: Ticket, expectedVersion: number, data: Prisma.TicketUpdateInput): Promise<TicketWithStatus> {
    try {
      return await tx.ticket.update({
        where: { id: ticket.id, version: expectedVersion },
        data: { ...data, version: { increment: 1 } },
        include: { status: true },
      });
    } catch (err) {
      // P2025: no row with this id AND version -> someone else changed it first.
      if (isRecordNotFound(err)) {
        throw new ConflictError('version_conflict', 'The ticket was changed by someone else. Refresh and try again.');
      }
      throw err;
    }
  }

  private async addHistory(
    tx: Tx,
    ticketId: string,
    actor: { userId: string },
    kind: HistoryKind,
    before: Prisma.InputJsonValue | null,
    after: Prisma.InputJsonValue,
    reason: string | null,
  ): Promise<void> {
    await tx.ticketHistory.create({
      data: {
        ticketId,
        actorUserId: actor.userId,
        kind,
        before: before ?? undefined,
        after,
        reason,
      },
    });
  }
}
