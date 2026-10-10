import type { PrismaClient } from '@prisma/client';
import { lockAgent, lockGroup } from '../db.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../errors.js';
import { type Actor, isAdmin } from '../../policies/ticket-policy.js';
import { ACTIVE_STATUSES } from '../tickets/workflow.js';

const activeTicket = { status: { code: { in: [...ACTIVE_STATUSES] } } };

function requireAdmin(actor: Actor): void {
  if (!isAdmin(actor)) throw new ForbiddenError('admin_only', 'Only an administrator may do this');
}

/**
 * Structural changes that could strand an active ticket (NEW, IN_PROGRESS, WAITING_CUSTOMER) with an
 * invalid group or assignee are rejected until the tickets are reassigned. RESOLVED, CLOSED and
 * UNRESOLVED tickets keep their historical assignment.
 */
export class GroupService {
  constructor(private readonly prisma: PrismaClient) {}

  async deactivateGroup(actor: Actor, groupId: string): Promise<void> {
    requireAdmin(actor);
    await this.prisma.$transaction(async (tx) => {
      const group = await lockGroup(tx, groupId, 'update');
      if (!group) throw new NotFoundError('group');
      const count = await tx.ticket.count({ where: { groupId, ...activeTicket } });
      if (count > 0) throw new ConflictError('has_active_tickets', `Group has ${count} active ticket(s); reassign them first`);
      await tx.supportGroup.update({ where: { id: groupId }, data: { isActive: false } });
    });
  }

  async removeMember(actor: Actor, agentId: string, groupId: string): Promise<void> {
    requireAdmin(actor);
    await this.prisma.$transaction(async (tx) => {
      if (!(await lockAgent(tx, agentId, 'update'))) throw new NotFoundError('agent');
      const count = await tx.ticket.count({ where: { groupId, assignedAgentId: agentId, ...activeTicket } });
      if (count > 0) throw new ConflictError('has_active_tickets', `Agent has ${count} active ticket(s) in this group; reassign them first`);
      const removed = await tx.agentGroup.deleteMany({ where: { agentId, groupId } });
      if (removed.count === 0) throw new NotFoundError('membership');
    });
  }
}
