import { createHash, randomUUID } from 'node:crypto';
import type { Attachment, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { loadScope, lockComment, lockTicket, type Tx } from '../db.js';
import { ConflictError, ForbiddenError, NotFoundError, StorageError } from '../errors.js';
import { canAddComment, canEditComment } from '../../policies/comment-policy.js';
import { type Actor, canAccessGroup, ticketScopeWhere } from '../../policies/ticket-policy.js';
import { type ObjectStorage } from '../../storage/storage.js';
import { type CheckedFile, validateUpload } from '../../storage/file-validation.js';
import { MAX_ATTACHMENTS_PER_COMMENT } from '../../storage/limits.js';

export const DOWNLOAD_URL_SECONDS = 60;

const uuid = z.uuid();

export interface UploadedFile {
  originalName: string;
  declaredType: string;
  data: Buffer;
}

/**
 * Attachments of comments (requirements section 10). The database row and the stored object are separate
 * systems without a shared transaction, so every state change is ordered to be recoverable:
 *   upload: PENDING row -> put object -> READY (or FAILED and best-effort delete)
 *   delete: DELETING row -> delete object -> remove row
 * `storage:reconcile` finishes whatever a crash left half-done. Who may upload or delete is exactly who may
 * edit the comment: an ADMIN on any comment, an AGENT on their own, never on a CLOSED or UNRESOLVED ticket.
 */
export class AttachmentService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly storage: ObjectStorage,
  ) {}

  async upload(actor: Actor, commentId: string, file: UploadedFile): Promise<Attachment> {
    const checked = validateUpload(file); // size, type, signature, extension, text encoding
    if (!uuid.safeParse(commentId).success) throw new NotFoundError('comment');

    const pending = await this.reserve(actor, commentId, checked, file.data);
    try {
      await this.storage.put(pending.objectKey, file.data, checked.contentType);
    } catch {
      await this.discard(pending);
      throw new StorageError(); // generic on purpose: provider messages can contain endpoints and keys
    }

    // The upload took a while: if the ticket was closed meanwhile, the attachment must not appear.
    const ready = await this.prisma.$transaction(async (tx) => {
      const ticket = await lockTicket(tx, (await tx.comment.findUniqueOrThrow({ where: { id: commentId } })).ticketId, 'share');
      if (!ticket || !canAddComment(ticket.statusCode)) return null;
      const result = await tx.attachment.updateMany({ where: { id: pending.id, state: 'PENDING' }, data: { state: 'READY', stateChangedAt: new Date() } });
      return result.count === 1 ? tx.attachment.findUniqueOrThrow({ where: { id: pending.id } }) : null;
    });
    if (!ready) {
      await this.discard(pending);
      throw new ConflictError('ticket_frozen', 'The ticket was closed while the file was uploading.');
    }
    return ready;
  }

  /** A 60-second URL that downloads the file as an attachment. Only READY files, only for tickets in scope. */
  async downloadUrl(actor: Actor, attachmentId: string): Promise<string> {
    if (!uuid.safeParse(attachmentId).success) throw new NotFoundError('attachment');
    const scope = await loadScope(this.prisma, actor);
    const attachment = await this.prisma.attachment.findFirst({
      where: { id: attachmentId, state: 'READY', comment: { ticket: ticketScopeWhere(scope) } },
    });
    if (!attachment) throw new NotFoundError('attachment');
    try {
      return await this.storage.presignGet(attachment.objectKey, {
        filename: attachment.originalName,
        contentType: attachment.contentType,
        expiresSeconds: DOWNLOAD_URL_SECONDS,
      });
    } catch {
      throw new StorageError();
    }
  }

  /** Safe to repeat: a half-finished deletion is completed by calling it again. */
  async remove(actor: Actor, attachmentId: string): Promise<void> {
    if (!uuid.safeParse(attachmentId).success) throw new NotFoundError('attachment');
    const attachment = await this.prisma.$transaction(async (tx) => {
      const found = await tx.attachment.findUnique({ where: { id: attachmentId }, include: { comment: true } });
      if (!found) throw new NotFoundError('attachment');
      const ticket = await lockTicket(tx, found.comment.ticketId, 'share');
      if (!ticket) throw new NotFoundError('attachment');
      if (!canAccessGroup(await loadScope(tx, actor), ticket.groupId)) throw new NotFoundError('attachment');
      if (!canAddComment(ticket.statusCode)) {
        throw new ConflictError('ticket_frozen', 'CLOSED and UNRESOLVED tickets must be reopened before attachments can change');
      }
      if (!canEditComment(actor, found.comment.authorUserId, ticket.statusCode)) {
        throw new ForbiddenError('not_author', 'You can change attachments only on your own comments');
      }
      await tx.attachment.update({ where: { id: attachmentId }, data: { state: 'DELETING', stateChangedAt: new Date() } });
      return found;
    });

    try {
      await this.storage.delete(attachment.objectKey);
    } catch {
      throw new StorageError(); // the row stays DELETING; repeating the call or reconcile finishes the job
    }
    await this.prisma.attachment.deleteMany({ where: { id: attachmentId } });
  }

  /**
   * Step 1 and 2 of an upload, in one short transaction: re-check access and status under the ticket lock,
   * then take the comment lock so concurrent uploads cannot exceed the limit (PENDING counts as well as READY).
   */
  private async reserve(actor: Actor, commentId: string, checked: CheckedFile, data: Buffer): Promise<Attachment> {
    return this.prisma.$transaction(async (tx: Tx) => {
      const comment = await tx.comment.findUnique({ where: { id: commentId } });
      if (!comment) throw new NotFoundError('comment');
      const ticket = await lockTicket(tx, comment.ticketId, 'share');
      if (!ticket || !canAccessGroup(await loadScope(tx, actor), ticket.groupId)) throw new NotFoundError('comment');
      if (!canAddComment(ticket.statusCode)) {
        throw new ConflictError('ticket_frozen', 'CLOSED and UNRESOLVED tickets must be reopened before attachments can be added');
      }
      if (!canEditComment(actor, comment.authorUserId, ticket.statusCode)) {
        throw new ForbiddenError('not_author', 'You can attach files only to your own comments');
      }

      await lockComment(tx, commentId);
      const used = await tx.attachment.count({ where: { commentId, state: { in: ['PENDING', 'READY'] } } });
      if (used >= MAX_ATTACHMENTS_PER_COMMENT) {
        throw new ConflictError('attachment_limit', `A comment can have at most ${MAX_ATTACHMENTS_PER_COMMENT} attachments`);
      }
      return tx.attachment.create({
        data: {
          commentId,
          bucket: this.storage.bucket,
          // Chosen here, never by the browser.
          objectKey: `tickets/${comment.ticketId}/comments/${commentId}/${randomUUID()}`,
          originalName: checked.originalName,
          contentType: checked.contentType,
          sizeBytes: data.length,
          sha256: createHash('sha256').update(data).digest('hex'),
          state: 'PENDING',
          createdByUserId: actor.userId,
        },
      });
    });
  }

  /** Marks the row FAILED and tries to remove any object that was written. Never throws. */
  private async discard(attachment: Attachment): Promise<void> {
    await this.prisma.attachment.updateMany({ where: { id: attachment.id }, data: { state: 'FAILED', stateChangedAt: new Date() } }).catch(() => undefined);
    await this.storage.delete(attachment.objectKey).catch(() => undefined); // reconcile retries if this fails
  }
}
