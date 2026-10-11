import type { Prisma, Ticket } from '@prisma/client';

/** The fields of a ticket that history entries record before and after a change. */
export type SnapshotSource = Pick<
  Ticket,
  'subject' | 'description' | 'priority' | 'groupId' | 'assignedAgentId' | 'resolution' | 'unresolvedReason' | 'resolvedAt' | 'unresolvedAt' | 'closedAt'
> & { status: { code: string } };

/** Dates become ISO strings so snapshots are plain JSON. Shared by TicketService and the demo seed. */
export function ticketSnapshot(t: SnapshotSource): Prisma.InputJsonValue {
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
