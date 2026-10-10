import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { loadScope } from '../db.js';
import { NotFoundError } from '../errors.js';
import { type Actor, canAccessGroup, isAdmin } from '../../policies/ticket-policy.js';

export interface GroupMembersView {
  /** Only ADMIN edits membership; an AGENT may see who is in their own group. */
  canEdit: boolean;
  groupActive: boolean;
  members: Array<{ agentId: string; name: string; isActive: boolean }>;
  /** Active agents who could be added (ADMIN only). */
  candidates: Array<{ id: string; name: string }>;
}

export class GroupQueries {
  constructor(private readonly prisma: PrismaClient) {}

  /** A group outside the actor's scope behaves as if it did not exist. */
  async members(actor: Actor, groupId: string): Promise<GroupMembersView> {
    if (!z.uuid().safeParse(groupId).success) throw new NotFoundError('group');
    const scope = await loadScope(this.prisma, actor);
    if (!canAccessGroup(scope, groupId)) throw new NotFoundError('group');
    const group = await this.prisma.supportGroup.findUnique({ where: { id: groupId } });
    if (!group) throw new NotFoundError('group');

    const rows = await this.prisma.agentGroup.findMany({
      where: { groupId },
      include: { agent: { select: { id: true, displayName: true, isActive: true } } },
    });
    const members = rows
      .map((r) => ({ agentId: r.agent.id, name: r.agent.displayName, isActive: r.agent.isActive }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const canEdit = isAdmin(actor);
    const candidates =
      canEdit && group.isActive
        ? (
            await this.prisma.agent.findMany({
              where: { isActive: true, groups: { none: { groupId } } },
              select: { id: true, displayName: true },
              orderBy: { displayName: 'asc' },
            })
          ).map((a) => ({ id: a.id, name: a.displayName }))
        : [];
    return { canEdit, groupActive: group.isActive, members, candidates };
  }
}
