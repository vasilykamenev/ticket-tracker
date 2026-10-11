import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { loadScope } from '../db.js';
import { NotFoundError } from '../errors.js';
import { canAddComment, canEditComment } from '../../policies/comment-policy.js';
import { type Actor, ticketScopeWhere } from '../../policies/ticket-policy.js';
import { MAX_ATTACHMENTS_PER_COMMENT } from '../../storage/limits.js';

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
  /** Only finished uploads (READY) are listed. */
  attachments: Array<{ id: string; name: string; size: number; contentType: string }>;
  /** Editing rights and room for one more (pending uploads count towards the limit). */
  canAttach: boolean;
  /** Same people who may edit the comment may remove its files. */
  canDeleteAttachments: boolean;
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
        include: {
          author: { select: { displayName: true } },
          attachments: { where: { state: { in: ['PENDING', 'READY'] } }, orderBy: { createdAt: 'asc' } },
        },
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
        attachments: c.attachments.filter((a) => a.state === 'READY').map((a) => ({ id: a.id, name: a.originalName, size: a.sizeBytes, contentType: a.contentType })),
        canAttach: canEditComment(actor, c.authorUserId, ticket.status.code) && c.attachments.length < MAX_ATTACHMENTS_PER_COMMENT,
        canDeleteAttachments: canEditComment(actor, c.authorUserId, ticket.status.code),
      })),
      total,
      page: pageNo,
      perPage: PAGE_SIZE,
      canAdd: canAddComment(ticket.status.code),
      statusName: ticket.status.name,
    };
  }
}
