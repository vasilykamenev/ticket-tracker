import type { Comment, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { isRecordNotFound, loadScope, lockTicket, type Tx } from '../db.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors.js';
import { canAddComment, canEditComment } from '../../policies/comment-policy.js';
import { type Actor, type Scope, canAccessGroup } from '../../policies/ticket-policy.js';
import { parseInput, versionSchema } from '../tickets/schemas.js';
import { commentInputSchema } from './schemas.js';

const uuid = z.uuid();

/**
 * Comments on tickets. The ticket id comes from the record being viewed and the author from the session;
 * neither is ever read from the payload. Every method takes a lock on the ticket row, so a comment cannot
 * be added or edited on a ticket that is concurrently being closed or marked unresolved. Comments are never
 * deleted. Rules: requirements sections 6 and 7.
 */
export class CommentService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Any staff member who can see the ticket may comment, unless it is CLOSED or UNRESOLVED. */
  async add(actor: Actor, ticketId: string, input: unknown): Promise<Comment> {
    const data = parseInput(commentInputSchema, input);
    if (!uuid.safeParse(ticketId).success) throw new NotFoundError('ticket');
    return this.prisma.$transaction(async (tx) => {
      // UPDATE lock: adding a comment also touches the ticket (see below).
      const ticket = await lockTicket(tx, ticketId, 'update');
      if (!ticket) throw new NotFoundError('ticket');
      this.assertVisible(await loadScope(tx, actor), ticket.groupId, 'ticket');
      if (!canAddComment(ticket.statusCode)) {
        throw new ConflictError('ticket_frozen', 'CLOSED and UNRESOLVED tickets must be reopened before they take comments');
      }
      const comment = await tx.comment.create({ data: { ticketId, authorUserId: actor.userId, body: data.body } });
      // Activity moves the ticket up the "recently updated" list. `version` is deliberately left alone:
      // it guards edits of the ticket itself, and a comment must not make someone's open edit stale.
      await tx.ticket.update({ where: { id: ticketId }, data: { updatedAt: this.now() } });
      return comment;
    });
  }

  /**
   * ADMIN edits any comment, an AGENT their own. Optimistic locking on the comment's own version.
   * When the caller names the ticket (the AdminJS action does: it is the page being viewed), the comment
   * must belong to it.
   */
  async edit(actor: Actor, commentId: string, expectedVersion: number, input: unknown, ticketId?: string): Promise<Comment> {
    const data = parseInput(commentInputSchema, input);
    const version = parseInput(versionSchema, expectedVersion);
    if (!uuid.safeParse(commentId).success) throw new NotFoundError('comment');
    return this.prisma.$transaction(async (tx) => {
      const comment = await tx.comment.findUnique({ where: { id: commentId } });
      if (!comment || (ticketId !== undefined && comment.ticketId !== ticketId)) throw new NotFoundError('comment');
      const ticket = await lockTicket(tx, comment.ticketId, 'share');
      if (!ticket) throw new NotFoundError('comment');
      this.assertVisible(await loadScope(tx, actor), ticket.groupId, 'comment');

      if (!canAddComment(ticket.statusCode)) {
        throw new ConflictError('ticket_frozen', 'CLOSED and UNRESOLVED tickets must be reopened before their comments can change');
      }
      if (!canEditComment(actor, comment.authorUserId, ticket.statusCode)) {
        throw new ForbiddenError('not_author', 'You can edit only your own comments');
      }
      if (comment.version !== version) throw this.conflict();
      if (comment.body === data.body) throw new ValidationError('no_change', 'Nothing to change');

      return this.update(tx, commentId, version, data.body);
    });
  }

  private async update(tx: Tx, commentId: string, version: number, body: string): Promise<Comment> {
    try {
      return await tx.comment.update({
        where: { id: commentId, version },
        data: { body, version: { increment: 1 } },
      });
    } catch (err) {
      // No row with this id AND version: someone saved first.
      if (isRecordNotFound(err)) throw this.conflict();
      throw err;
    }
  }

  private conflict(): ConflictError {
    return new ConflictError('version_conflict', 'The comment was changed by someone else. Refresh and try again.');
  }

  /** Outside the actor's scope behaves as if it did not exist. */
  private assertVisible(scope: Scope, groupId: string, what: string): void {
    if (!canAccessGroup(scope, groupId)) throw new NotFoundError(what);
  }
}
