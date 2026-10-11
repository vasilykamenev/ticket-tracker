import type { Prisma } from '@prisma/client';
import { type Actor, type Scope, scopeFor } from '../policies/ticket-policy.js';

export type Tx = Prisma.TransactionClient;
/** Prisma "unique constraint failed" (P2002). */
export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

/** Prisma "record to update/delete does not exist" (P2025). */
export function isRecordNotFound(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2025';
}

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

export async function lockStatus(tx: Tx, statusId: string, mode: LockMode): Promise<{ isActive: boolean } | null> {
  const rows =
    mode === 'share'
      ? await tx.$queryRaw<{ isActive: boolean }[]>`SELECT "isActive" FROM support."TicketStatus" WHERE id = ${statusId}::uuid FOR SHARE`
      : await tx.$queryRaw<{ isActive: boolean }[]>`SELECT "isActive" FROM support."TicketStatus" WHERE id = ${statusId}::uuid FOR UPDATE`;
  return rows[0] ?? null;
}

/**
 * Locks a ticket row and returns its group and status as they are after any concurrent change committed.
 * Comments take this lock so a comment cannot slip onto a ticket that is being closed or marked unresolved:
 * a status change updates the same row, so one of the two waits for the other. 'update' is for writers that
 * also touch the ticket (adding a comment bumps updatedAt); two 'share' holders never block each other.
 */
export async function lockTicket(tx: Tx, ticketId: string, mode: LockMode): Promise<{ groupId: string; statusCode: string } | null> {
  // One table only: when a concurrent update commits while we wait, Postgres re-reads the locked row but not
  // the tables joined to it, so a JOIN here would drop the row. The status is read separately afterwards.
  const rows =
    mode === 'share'
      ? await tx.$queryRaw<{ groupId: string; statusId: string }[]>`SELECT "groupId", "statusId" FROM support."Ticket" WHERE id = ${ticketId}::uuid FOR SHARE`
      : await tx.$queryRaw<{ groupId: string; statusId: string }[]>`SELECT "groupId", "statusId" FROM support."Ticket" WHERE id = ${ticketId}::uuid FOR UPDATE`;
  const row = rows[0];
  if (!row) return null;
  const status = await tx.ticketStatus.findUniqueOrThrow({ where: { id: row.statusId }, select: { code: true } });
  return { groupId: row.groupId, statusCode: status.code };
}

/**
 * Serializes concurrent uploads to one comment so the per-comment attachment limit cannot be exceeded.
 * Always taken after the ticket lock (ticket, then comment) so the two cannot deadlock.
 */
export async function lockComment(tx: Tx, commentId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM support."Comment" WHERE id = ${commentId}::uuid FOR UPDATE`;
}

/**
 * Locks every active ADMIN row (in id order, so concurrent callers cannot deadlock) and returns their
 * ids. Anything that could remove an active administrator takes this lock first, so two concurrent
 * demotions cannot each see "someone else is still an admin".
 */
export async function lockActiveAdmins(tx: Tx): Promise<string[]> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM support."User" WHERE role = 'ADMIN' AND "isActive" = true ORDER BY id FOR UPDATE`;
  return rows.map((r) => r.id);
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
