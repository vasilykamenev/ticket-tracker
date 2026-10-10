import type { PrismaClient, SupportGroup } from '@prisma/client';
import { lockAgent, lockGroup, type Tx } from '../db.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors.js';
import { type Actor, isAdmin } from '../../policies/ticket-policy.js';
import { parseInput } from '../tickets/schemas.js';
import { ACTIVE_STATUSES } from '../tickets/workflow.js';
import { createGroupSchema, membershipSchema, updateGroupSchema } from './schemas.js';

const activeTicket = { status: { code: { in: [...ACTIVE_STATUSES] } } };
const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code === 'P2002';

function requireAdmin(actor: Actor): void {
  if (!isAdmin(actor)) throw new ForbiddenError('admin_only', 'Only an administrator may do this');
}

async function deactivateGroupInTx(tx: Tx, groupId: string): Promise<void> {
  const group = await lockGroup(tx, groupId, 'update');
  if (!group) throw new NotFoundError('group');
  const count = await tx.ticket.count({ where: { groupId, ...activeTicket } });
  if (count > 0) throw new ConflictError('has_active_tickets', `Group has ${count} active ticket(s); reassign them first`);
  await tx.supportGroup.update({ where: { id: groupId }, data: { isActive: false } });
}

/**
 * Support groups and their memberships. ADMIN only. Structural changes that could strand an active
 * ticket (NEW, IN_PROGRESS, WAITING_CUSTOMER) with an invalid group or assignee are rejected until the
 * tickets are reassigned. RESOLVED, CLOSED and UNRESOLVED tickets keep their historical assignment.
 */
export class GroupService {
  constructor(private readonly prisma: PrismaClient) {}

  async create(actor: Actor, input: unknown): Promise<SupportGroup> {
    requireAdmin(actor);
    const data = parseInput(createGroupSchema, input);
    try {
      return await this.prisma.supportGroup.create({ data: { code: data.code, name: data.name, description: data.description ?? null } });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ValidationError('validation', 'Invalid input', { code: 'a group with this code already exists' });
      throw err;
    }
  }

  /** Name, description and active state. The code never changes. */
  async update(actor: Actor, groupId: string, input: unknown): Promise<SupportGroup> {
    requireAdmin(actor);
    const data = parseInput(updateGroupSchema, input);
    return this.prisma.$transaction(async (tx) => {
      const group = await lockGroup(tx, groupId, 'update');
      if (!group) throw new NotFoundError('group');
      if (data.isActive === false && group.isActive) await deactivateGroupInTx(tx, groupId);
      return tx.supportGroup.update({
        where: { id: groupId },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.description !== undefined && { description: data.description }),
          ...(data.isActive === true && { isActive: true }),
        },
      });
    });
  }

  async deactivateGroup(actor: Actor, groupId: string): Promise<void> {
    requireAdmin(actor);
    await this.prisma.$transaction((tx) => deactivateGroupInTx(tx, groupId));
  }

  /** Only an active agent can join an active group. Locks group then agent (the order used everywhere). */
  async addMember(actor: Actor, agentId: string, groupId: string): Promise<void> {
    requireAdmin(actor);
    const ids = parseInput(membershipSchema, { agentId, groupId });
    await this.prisma.$transaction(async (tx) => {
      const group = await lockGroup(tx, ids.groupId, 'share');
      if (!group) throw new NotFoundError('group');
      if (!group.isActive) throw new ValidationError('validation', 'Invalid input', { groupId: 'the group is inactive' });
      const agent = await lockAgent(tx, ids.agentId, 'share');
      if (!agent) throw new NotFoundError('agent');
      if (!agent.isActive) throw new ValidationError('validation', 'Invalid input', { agentId: 'the agent is inactive' });
      try {
        await tx.agentGroup.create({ data: ids });
      } catch (err) {
        if (isUniqueViolation(err)) throw new ValidationError('validation', 'Invalid input', { agentId: 'already a member of this group' });
        throw err;
      }
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
