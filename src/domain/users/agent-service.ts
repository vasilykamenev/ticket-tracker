import type { Agent, PrismaClient } from '@prisma/client';
import { lockAgent, type Tx } from '../db.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors.js';
import { type Actor, isAdmin } from '../../policies/ticket-policy.js';
import { parseInput } from '../tickets/schemas.js';
import { ACTIVE_STATUSES } from '../tickets/workflow.js';
import { createAgentProfileSchema, updateAgentSchema } from './schemas.js';

function requireAdmin(actor: Actor): void {
  if (!isAdmin(actor)) throw new ForbiddenError('admin_only', 'Only an administrator may do this');
}

/**
 * Deactivates an agent profile unless it still holds active tickets (NEW, IN_PROGRESS,
 * WAITING_CUSTOMER). Shared with user deactivation so both apply the same rule in one transaction.
 */
export async function deactivateAgentInTx(tx: Tx, agentId: string): Promise<void> {
  if (!(await lockAgent(tx, agentId, 'update'))) throw new NotFoundError('agent');
  const count = await tx.ticket.count({ where: { assignedAgentId: agentId, status: { code: { in: [...ACTIVE_STATUSES] } } } });
  if (count > 0) throw new ConflictError('has_active_tickets', `Agent has ${count} active ticket(s); reassign them first`);
  await tx.agent.update({ where: { id: agentId }, data: { isActive: false } });
}

export class AgentService {
  constructor(private readonly prisma: PrismaClient) {}

  /** Refused while the agent holds active tickets; the agent loses access on the next request. */
  async deactivateAgent(actor: Actor, agentId: string): Promise<void> {
    requireAdmin(actor);
    await this.prisma.$transaction((tx) => deactivateAgentInTx(tx, agentId));
  }

  /** An agent can only work while their account is active. */
  async activateAgent(actor: Actor, agentId: string): Promise<void> {
    requireAdmin(actor);
    await this.prisma.$transaction(async (tx) => {
      if (!(await lockAgent(tx, agentId, 'update'))) throw new NotFoundError('agent');
      const agent = await tx.agent.findUniqueOrThrow({ where: { id: agentId }, include: { user: true } });
      if (!agent.user.isActive) throw new ValidationError('validation', 'Invalid input', { isActive: 'the staff account is inactive; activate it first' });
      await tx.agent.update({ where: { id: agentId }, data: { isActive: true } });
    });
  }

  /** The support profile of an existing staff account (an ADMIN needs one before they can be assigned tickets). */
  async createProfile(actor: Actor, input: unknown): Promise<Agent> {
    requireAdmin(actor);
    const data = parseInput(createAgentProfileSchema, input);
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: data.userId }, include: { agent: true } });
      if (!user?.isActive) throw new ValidationError('validation', 'Invalid input', { userId: 'staff account is unknown or inactive' });
      if (user.agent) throw new ValidationError('validation', 'Invalid input', { userId: 'this account already has a support profile' });
      return tx.agent.create({ data: { userId: user.id, displayName: data.displayName ?? user.displayName } });
    });
  }

  async update(actor: Actor, agentId: string, input: unknown): Promise<Agent> {
    requireAdmin(actor);
    const data = parseInput(updateAgentSchema, input);
    const current = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!current) throw new NotFoundError('agent');
    if (data.isActive !== undefined && data.isActive !== current.isActive) {
      if (data.isActive) await this.activateAgent(actor, agentId);
      else await this.deactivateAgent(actor, agentId);
    }
    if (data.displayName !== undefined && data.displayName !== current.displayName) {
      await this.prisma.agent.update({ where: { id: agentId }, data: { displayName: data.displayName } });
    }
    return this.prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
  }
}
