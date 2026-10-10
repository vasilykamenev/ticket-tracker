import type { PrismaClient } from '@prisma/client';
import { lockAgent } from '../db.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../errors.js';
import { type Actor, isAdmin } from '../../policies/ticket-policy.js';
import { ACTIVE_STATUSES } from '../tickets/workflow.js';

export class AgentService {
  constructor(private readonly prisma: PrismaClient) {}

  /** Refused while the agent holds active tickets; the agent loses access on the next request. */
  async deactivateAgent(actor: Actor, agentId: string): Promise<void> {
    if (!isAdmin(actor)) throw new ForbiddenError('admin_only', 'Only an administrator may do this');
    await this.prisma.$transaction(async (tx) => {
      if (!(await lockAgent(tx, agentId, 'update'))) throw new NotFoundError('agent');
      const count = await tx.ticket.count({
        where: { assignedAgentId: agentId, status: { code: { in: [...ACTIVE_STATUSES] } } },
      });
      if (count > 0) throw new ConflictError('has_active_tickets', `Agent has ${count} active ticket(s); reassign them first`);
      await tx.agent.update({ where: { id: agentId }, data: { isActive: false } });
    });
  }
}
