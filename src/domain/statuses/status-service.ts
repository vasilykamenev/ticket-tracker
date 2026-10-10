import type { PrismaClient, TicketStatus } from '@prisma/client';
import { z } from 'zod';
import { lockStatus } from '../db.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors.js';
import { type Actor, isAdmin } from '../../policies/ticket-policy.js';
import { parseInput } from '../tickets/schemas.js';
import { updateStatusSchema } from './schemas.js';

/**
 * Presentation of the system statuses: name, color, order and whether the status is offered.
 * Codes and the transition matrix live in code (workflow.ts); this is not a workflow designer, and
 * there is no way to create a status here (new codes need a migration and workflow tests).
 */
export class StatusService {
  constructor(private readonly prisma: PrismaClient) {}

  async update(actor: Actor, statusId: string, input: unknown): Promise<TicketStatus> {
    if (!isAdmin(actor)) throw new ForbiddenError('admin_only', 'Only an administrator may do this');
    const data = parseInput(updateStatusSchema, input);
    if (!z.uuid().safeParse(statusId).success) throw new NotFoundError('status');
    return this.prisma.$transaction(async (tx) => {
      // UPDATE lock: a ticket moving into this status takes a SHARE lock, so it waits for us or we see it.
      if (!(await lockStatus(tx, statusId, 'update'))) throw new NotFoundError('status');
      const status = await tx.ticketStatus.findUniqueOrThrow({ where: { id: statusId } });
      if (data.isActive === false && status.isActive) {
        if (status.code === 'NEW') {
          throw new ValidationError('validation', 'Invalid input', { isActive: 'NEW is needed to create tickets and cannot be deactivated' });
        }
        const inUse = await tx.ticket.count({ where: { statusId } });
        if (inUse > 0) throw new ConflictError('status_in_use', `${inUse} ticket(s) have this status; it cannot be deactivated`);
      }
      return tx.ticketStatus.update({ where: { id: statusId }, data });
    });
  }
}
