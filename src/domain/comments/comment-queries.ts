import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { loadScope } from '../db.js';
import { NotFoundError } from '../errors.js';
import { canAddComment, canEditComment } from '../../policies/comment-policy.js';
import { type Actor, ticketScopeWhere } from '../../policies/ticket-policy.js';

const PAGE_SIZE = 10;

export interface CommentItem {
  id: string;
  authorName: string;
  body: string;
  version: number;
  createdAt: string;
  /** True once the text was changed after it was posted. */
  edited: boolean;
  /** Computed for this viewer and this ticket status; the server checks again on save. */
  canEdit: boolean;
}

export interface CommentsPage {
  items: CommentItem[];
  total: number;
  page: number;
  perPage: number;
  canAdd: boolean;
  statusName: string;
}

export class CommentQueries {
  constructor(private readonly prisma: PrismaClient) {}

  /** Oldest first, so a thread reads top to bottom. A ticket outside the scope behaves as if absent. */
  async list(actor: Actor, ticketId: string, page = 1): Promise<CommentsPage> {
    if (!z.uuid().safeParse(ticketId).success) throw new NotFoundError('ticket');
    const scope = await loadScope(this.prisma, actor);
    const ticket = await this.prisma.ticket.findFirst({
      where: { AND: [{ id: ticketId }, ticketScopeWhere(scope)] },
      include: { status: true },
    });
    if (!ticket) throw new NotFoundError('ticket');

    const pageNo = Math.max(1, Math.floor(page) || 1);
    const [total, rows] = await Promise.all([
      this.prisma.comment.count({ where: { ticketId } }),
      this.prisma.comment.findMany({
        where: { ticketId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: (pageNo - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: { author: { select: { displayName: true } } },
      }),
    ]);
    return {
      items: rows.map((c) => ({
        id: c.id,
        authorName: c.author.displayName,
        body: c.body,
        version: c.version,
        createdAt: c.createdAt.toISOString(),
        edited: c.version > 1,
        canEdit: canEditComment(actor, c.authorUserId, ticket.status.code),
      })),
      total,
      page: pageNo,
      perPage: PAGE_SIZE,
      canAdd: canAddComment(ticket.status.code),
      statusName: ticket.status.name,
    };
  }
}
