import type { Prisma } from '@prisma/client';
import { type Actor, type Scope, scopeFor } from '../policies/ticket-policy.js';

export type Tx = Prisma.TransactionClient;
export type LockMode = 'share' | 'update';

/**
 * Row locks serialize "assign a ticket to X" against "deactivate X / remove X from a group":
 * assignment takes a SHARE lock, deactivation takes an UPDATE lock and then counts active tickets.
 * Whichever transaction goes second sees the other's committed result, so no active ticket is left
 * assigned to an inactive agent or inactive group. Table names are literals, never user input.
 */
export async function lockAgent(tx: Tx, agentId: string, mode: LockMode): Promise<{ isActive: boolean } | null> {
  const rows =
    mode === 'share'
      ? await tx.$queryRaw<{ isActive: boolean }[]>`SELECT "isActive" FROM support."Agent" WHERE id = ${agentId}::uuid FOR SHARE`
      : await tx.$queryRaw<{ isActive: boolean }[]>`SELECT "isActive" FROM support."Agent" WHERE id = ${agentId}::uuid FOR UPDATE`;
  return rows[0] ?? null;
}

export async function lockGroup(tx: Tx, groupId: string, mode: LockMode): Promise<{ isActive: boolean } | null> {
  const rows =
    mode === 'share'
      ? await tx.$queryRaw<{ isActive: boolean }[]>`SELECT "isActive" FROM support."SupportGroup" WHERE id = ${groupId}::uuid FOR SHARE`
      : await tx.$queryRaw<{ isActive: boolean }[]>`SELECT "isActive" FROM support."SupportGroup" WHERE id = ${groupId}::uuid FOR UPDATE`;
  return rows[0] ?? null;
}

/** Loaded inside the caller's transaction so membership changes are seen immediately. */
export async function loadScope(tx: Tx, actor: Actor): Promise<Scope> {
  if (actor.role === 'ADMIN') return scopeFor(actor, []);
  if (!actor.agentId) return scopeFor(actor, []);
  const memberships = await tx.agentGroup.findMany({ where: { agentId: actor.agentId }, select: { groupId: true } });
  return scopeFor(
    actor,
    memberships.map((m) => m.groupId),
  );
}
