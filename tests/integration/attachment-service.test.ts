import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AttachmentService, DOWNLOAD_URL_SECONDS, MAX_ATTACHMENTS_PER_COMMENT } from '../../src/domain/attachments/attachment-service.js';
import { CommentQueries } from '../../src/domain/comments/comment-queries.js';
import { CommentService } from '../../src/domain/comments/comment-service.js';
import { DomainError } from '../../src/domain/errors.js';
import { TicketService } from '../../src/domain/tickets/ticket-service.js';
import { MemoryStorage } from '../../src/storage/memory-storage.js';
import { Fixtures } from './helpers/fixtures.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for integration tests (see .env.example)');

const prisma = new PrismaClient();
const fx = new Fixtures(prisma);
const storage = new MemoryStorage();
const attachments = new AttachmentService(prisma, storage);
const comments = new CommentService(prisma);
const queries = new CommentQueries(prisma);
const tickets = new TicketService(prisma);

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('image bytes')]);
const png = (name = 'screen.png') => ({ originalName: name, declaredType: 'image/png', data: PNG });
const text = (body = 'some log lines', name = 'log.txt') => ({ originalName: name, declaredType: 'text/plain', data: Buffer.from(body) });
const RESOLUTION = 'Restarted the sync job and verified';

async function failure(promise: Promise<unknown>): Promise<DomainError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, 'expected a DomainError').toBeInstanceOf(DomainError);
  return err as DomainError;
}

beforeAll(async () => {
  await fx.init();
});
afterAll(async () => {
  await fx.cleanup();
  await prisma.$disconnect();
});

async function scenario() {
  const groupA = await fx.group();
  const groupB = await fx.group();
  const customer = await fx.customer();
  const admin = await fx.admin();
  const author = await fx.agent([groupA]);
  const colleague = await fx.agent([groupA]);
  const outsider = await fx.agent([groupB]);
  const created = await tickets.create(admin.actor, { subject: 'Printer offline', description: 'd', customerId: customer.id, groupId: groupA.id, assignedAgentId: author.agent.id });
  const ticket = await tickets.changeStatus(admin.actor, created.id, created.version, { targetStatus: 'IN_PROGRESS' });
  const comment = await comments.add(author.actor, ticket.id, { body: 'See the attached screenshot' });
  return { admin, author, colleague, outsider, ticket, comment };
}
type Scenario = Awaited<ReturnType<typeof scenario>>;

const close = async (s: Scenario) => {
  const resolved = await tickets.changeStatus(s.admin.actor, s.ticket.id, s.ticket.version, { targetStatus: 'RESOLVED', resolution: RESOLUTION });
  return tickets.changeStatus(s.admin.actor, resolved.id, resolved.version, { targetStatus: 'CLOSED' });
};

describe('uploading', () => {
  it('stores the object, and the row goes PENDING -> READY with a server-chosen key', async () => {
    const s = await scenario();
    const a = await attachments.upload(s.author.actor, s.comment.id, png('Скриншот.png'));
    expect(a).toMatchObject({ commentId: s.comment.id, state: 'READY', originalName: 'Скриншот.png', contentType: 'image/png', sizeBytes: PNG.length, bucket: storage.bucket, createdByUserId: s.author.user.id });
    expect(a.objectKey).toMatch(new RegExp(`^tickets/${s.ticket.id}/comments/${s.comment.id}/[0-9a-f-]{36}$`));
    expect(a.sha256).toBe(createHash('sha256').update(PNG).digest('hex'));
    expect(storage.get(a.objectKey)!.equals(PNG)).toBe(true);
  });

  it('never uses the client file name in the key, and strips path parts from the stored name', async () => {
    const s = await scenario();
    const a = await attachments.upload(s.author.actor, s.comment.id, png('../../etc/passwd.png'));
    expect(a.originalName).toBe('passwd.png');
    expect(a.objectKey).not.toContain('passwd');
  });

  it('rejects bad files before anything is written', async () => {
    const s = await scenario();
    const before = storage.count;
    expect((await failure(attachments.upload(s.author.actor, s.comment.id, { ...png(), declaredType: 'application/pdf' }))).status).toBe(415);
    expect((await failure(attachments.upload(s.author.actor, s.comment.id, { originalName: 'x.png', declaredType: 'image/png', data: Buffer.alloc(10 * 1024 * 1024 + 1, 1) }))).status).toBe(413);
    expect((await failure(attachments.upload(s.author.actor, s.comment.id, { originalName: 'logo.svg', declaredType: 'image/svg+xml', data: Buffer.from('<svg/>') }))).status).toBe(415);
    expect(storage.count).toBe(before);
    expect(await prisma.attachment.count({ where: { commentId: s.comment.id } })).toBe(0);
  });

  it('follows the right to edit the comment: author or ADMIN, never a colleague or another group', async () => {
    const s = await scenario();
    await expect(attachments.upload(s.admin.actor, s.comment.id, text())).resolves.toBeTruthy();
    const notAuthor = await failure(attachments.upload(s.colleague.actor, s.comment.id, text()));
    expect(notAuthor.code).toBe('not_author');
    expect((await failure(attachments.upload(s.outsider.actor, s.comment.id, text()))).status).toBe(404);
    expect((await failure(attachments.upload(s.author.actor, 'nope', text()))).status).toBe(404);
    expect(await prisma.attachment.count({ where: { commentId: s.comment.id } })).toBe(1);
  });

  it('is refused on CLOSED and UNRESOLVED tickets and works again after reopening', async () => {
    const s = await scenario();
    const closed = await close(s);
    expect((await failure(attachments.upload(s.admin.actor, s.comment.id, text()))).code).toBe('ticket_frozen');
    const reopened = await tickets.changeStatus(s.admin.actor, closed.id, closed.version, { targetStatus: 'IN_PROGRESS', reason: 'Customer wrote back', assignedAgentId: s.author.agent.id });
    expect(reopened.status.code).toBe('IN_PROGRESS');
    await expect(attachments.upload(s.author.actor, s.comment.id, text())).resolves.toBeTruthy();
  });

  it('allows at most five per comment, and six simultaneous uploads leave exactly five', async () => {
    const s = await scenario();
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => attachments.upload(s.author.actor, s.comment.id, text(`file ${i}`, `f${i}.txt`))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(MAX_ATTACHMENTS_PER_COMMENT);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as DomainError).code).toBe('attachment_limit');
    expect(await prisma.attachment.count({ where: { commentId: s.comment.id, state: 'READY' } })).toBe(5);
    expect(storage.keys().filter((k) => k.includes(s.comment.id))).toHaveLength(5);
  });

  it('counts a deleted file as free room again', async () => {
    const s = await scenario();
    const made = [];
    for (let i = 0; i < 5; i++) made.push(await attachments.upload(s.author.actor, s.comment.id, text(`file ${i}`, `f${i}.txt`)));
    expect((await failure(attachments.upload(s.author.actor, s.comment.id, text('sixth', 'six.txt')))).code).toBe('attachment_limit');
    await attachments.remove(s.author.actor, made[0]!.id);
    await expect(attachments.upload(s.author.actor, s.comment.id, text('sixth', 'six.txt'))).resolves.toBeTruthy();
  });
});

describe('when storage misbehaves', () => {
  it('marks the row FAILED, leaves no object and says nothing about the provider', async () => {
    const s = await scenario();
    storage.failNext.put = new Error('connect ECONNREFUSED https://project.supabase.co key=AKIDEXAMPLE');
    const err = await failure(attachments.upload(s.author.actor, s.comment.id, png()));
    expect(err).toMatchObject({ code: 'storage_unavailable', status: 502 });
    expect(err.message).not.toMatch(/supabase|AKID|ECONNREFUSED/);

    const row = await prisma.attachment.findFirstOrThrow({ where: { commentId: s.comment.id } });
    expect(row.state).toBe('FAILED');
    expect(storage.has(row.objectKey)).toBe(false);
    // a failed upload does not use up one of the five places, and the next attempt works
    await expect(attachments.upload(s.author.actor, s.comment.id, png())).resolves.toBeTruthy();
  });

  it('discards the file when the ticket is closed while it uploads', async () => {
    const s = await scenario();
    const closedStatus = await prisma.ticketStatus.findUniqueOrThrow({ where: { code: 'CLOSED' } });
    const slow = new MemoryStorage();
    const service = new AttachmentService(prisma, slow);
    // the "upload" takes long enough for someone to close the ticket
    const originalPut = slow.put.bind(slow);
    slow.put = async (key, body, type) => {
      await originalPut(key, body, type);
      await prisma.ticket.update({ where: { id: s.ticket.id }, data: { statusId: closedStatus.id } });
    };
    const err = await failure(service.upload(s.author.actor, s.comment.id, png()));
    expect(err.code).toBe('ticket_frozen');
    expect(slow.count).toBe(0);
    expect(await prisma.attachment.count({ where: { commentId: s.comment.id, state: 'READY' } })).toBe(0);
  });
});

describe('downloading', () => {
  it('gives a 60-second attachment URL only to people who can see the ticket, and only for READY files', async () => {
    const s = await scenario();
    const a = await attachments.upload(s.author.actor, s.comment.id, png('Отчёт.png'));
    for (const actor of [s.author.actor, s.colleague.actor, s.admin.actor]) {
      const url = new URL(await attachments.downloadUrl(actor, a.id));
      expect(url.searchParams.get('expires')).toBe(String(DOWNLOAD_URL_SECONDS));
      expect(url.searchParams.get('disposition')).toMatch(/^attachment; filename="/);
      expect(url.searchParams.get('type')).toBe('image/png');
      expect(url.pathname).toContain(a.objectKey);
    }
    expect((await failure(attachments.downloadUrl(s.outsider.actor, a.id))).status).toBe(404);
    expect((await failure(attachments.downloadUrl(s.author.actor, 'nope'))).status).toBe(404);

    const pending = await prisma.attachment.update({ where: { id: a.id }, data: { state: 'PENDING' } });
    expect((await failure(attachments.downloadUrl(s.author.actor, pending.id))).status).toBe(404);
  });

  it('stays available on a closed ticket (reading is not editing)', async () => {
    const s = await scenario();
    const a = await attachments.upload(s.author.actor, s.comment.id, text());
    await close(s);
    await expect(attachments.downloadUrl(s.colleague.actor, a.id)).resolves.toContain(a.objectKey);
  });
});

describe('removing', () => {
  it('deletes the object and then the row, for the author or an ADMIN', async () => {
    const s = await scenario();
    const mine = await attachments.upload(s.author.actor, s.comment.id, text('mine', 'mine.txt'));
    const theirs = await attachments.upload(s.author.actor, s.comment.id, text('theirs', 'theirs.txt'));

    await attachments.remove(s.author.actor, mine.id);
    expect(storage.has(mine.objectKey)).toBe(false);
    expect(await prisma.attachment.findUnique({ where: { id: mine.id } })).toBeNull();

    expect((await failure(attachments.remove(s.colleague.actor, theirs.id))).code).toBe('not_author');
    expect((await failure(attachments.remove(s.outsider.actor, theirs.id))).status).toBe(404);
    await attachments.remove(s.admin.actor, theirs.id);
    expect(storage.has(theirs.objectKey)).toBe(false);
  });

  it('is refused on frozen tickets and for unknown ids', async () => {
    const s = await scenario();
    const a = await attachments.upload(s.author.actor, s.comment.id, text());
    await close(s);
    expect((await failure(attachments.remove(s.admin.actor, a.id))).code).toBe('ticket_frozen');
    expect(storage.has(a.objectKey)).toBe(true);
    expect((await failure(attachments.remove(s.admin.actor, 'nope'))).status).toBe(404);
  });

  it('can be repeated after a storage failure and then completes', async () => {
    const s = await scenario();
    const a = await attachments.upload(s.author.actor, s.comment.id, text());
    storage.failNext.delete = new Error('provider down');
    expect((await failure(attachments.remove(s.author.actor, a.id))).code).toBe('storage_unavailable');
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: a.id } })).state).toBe('DELETING'); // half done, recoverable
    expect((await failure(attachments.downloadUrl(s.author.actor, a.id))).status).toBe(404); // no longer downloadable

    await attachments.remove(s.author.actor, a.id);
    expect(await prisma.attachment.findUnique({ where: { id: a.id } })).toBeNull();
    expect(storage.has(a.objectKey)).toBe(false);
  });
});

describe('what the comment list shows', () => {
  it('lists READY files with the rights of this viewer', async () => {
    const s = await scenario();
    const ready = await attachments.upload(s.author.actor, s.comment.id, png('shown.png'));
    const failed = await attachments.upload(s.author.actor, s.comment.id, text('hidden', 'hidden.txt'));
    await prisma.attachment.update({ where: { id: failed.id }, data: { state: 'FAILED' } });

    const mine = (await queries.list(s.author.actor, s.ticket.id)).items[0]!;
    expect(mine.attachments).toEqual([{ id: ready.id, name: 'shown.png', size: PNG.length, contentType: 'image/png' }]);
    expect(mine).toMatchObject({ canAttach: true, canDeleteAttachments: true });

    const theirs = (await queries.list(s.colleague.actor, s.ticket.id)).items[0]!;
    expect(theirs.attachments).toHaveLength(1); // everyone who can see the ticket sees the files
    expect(theirs).toMatchObject({ canAttach: false, canDeleteAttachments: false });
  });

  it('says there is no room once five are used, and nothing is allowed on a closed ticket', async () => {
    const s = await scenario();
    for (let i = 0; i < 5; i++) await attachments.upload(s.author.actor, s.comment.id, text(`f${i}`, `f${i}.txt`));
    expect((await queries.list(s.author.actor, s.ticket.id)).items[0]).toMatchObject({ canAttach: false, canDeleteAttachments: true });
    await close(s);
    expect((await queries.list(s.admin.actor, s.ticket.id)).items[0]).toMatchObject({ canAttach: false, canDeleteAttachments: false });
  });
});
