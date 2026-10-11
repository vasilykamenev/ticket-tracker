import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AttachmentService } from '../../src/domain/attachments/attachment-service.js';
import { CommentService } from '../../src/domain/comments/comment-service.js';
import { TicketService } from '../../src/domain/tickets/ticket-service.js';
import { MemoryStorage } from '../../src/storage/memory-storage.js';
import { reconcile } from '../../src/storage/reconcile.js';
import { Fixtures } from './helpers/fixtures.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for integration tests (see .env.example)');

const prisma = new PrismaClient();
const fx = new Fixtures(prisma);
const tickets = new TicketService(prisma);
const comments = new CommentService(prisma);

const HOUR = 60 * 60 * 1000;
const now = new Date();
const old = new Date(now.getTime() - 2 * HOUR);
const fresh = new Date(now.getTime() - 5 * 60 * 1000);

beforeAll(async () => {
  await fx.init();
});
afterAll(async () => {
  await fx.cleanup();
  await prisma.$disconnect();
});

/** One comment to hang attachments on, and its own storage, so tests cannot see each other's objects. */
async function setup() {
  const group = await fx.group();
  const customer = await fx.customer();
  const admin = await fx.admin();
  const author = await fx.agent([group]);
  const ticket = await tickets.create(admin.actor, { subject: 'Reconcile target', description: 'd', customerId: customer.id, groupId: group.id });
  const comment = await comments.add(author.actor, ticket.id, { body: 'Files below' });
  const storage = new MemoryStorage();
  const keyOf = (id: string) => `tickets/${ticket.id}/comments/${comment.id}/${id}`;

  /** A row in an arbitrary state, with or without its object, created at an arbitrary time. */
  const row = async (state: 'PENDING' | 'READY' | 'FAILED' | 'DELETING', opts: { createdAt: Date; withObject?: boolean }) => {
    const objectKey = keyOf(randomUUID());
    const attachment = await prisma.attachment.create({
      data: { commentId: comment.id, bucket: storage.bucket, objectKey, originalName: 'f.txt', contentType: 'text/plain', sizeBytes: 3, sha256: 'a'.repeat(64), state, createdByUserId: author.user.id, createdAt: opts.createdAt, stateChangedAt: opts.createdAt },
    });
    if (opts.withObject ?? true) {
      await storage.put(objectKey, Buffer.from('abc'), 'text/plain');
      storage.age(objectKey, opts.createdAt);
    }
    return attachment;
  };
  return { storage, row, keyOf, ticket, comment, author, admin };
}

describe('storage:reconcile', () => {
  it('turns a stale PENDING upload into FAILED and deletes its object, but leaves a fresh one alone', async () => {
    const s = await setup();
    const stale = await s.row('PENDING', { createdAt: old });
    const inFlight = await s.row('PENDING', { createdAt: fresh });

    const report = await reconcile(prisma, s.storage, { dryRun: false, now });
    expect(report.stalePending).toContain(stale.id);
    expect(report.stalePending).not.toContain(inFlight.id);
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: stale.id } })).state).toBe('FAILED');
    expect(s.storage.has(stale.objectKey)).toBe(false);
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: inFlight.id } })).state).toBe('PENDING');
    expect(s.storage.has(inFlight.objectKey)).toBe(true);
  });

  it('keeps a row it just failed for the next run, and removes it then', async () => {
    const s = await setup();
    const stale = await s.row('PENDING', { createdAt: old });
    await reconcile(prisma, s.storage, { dryRun: false, now });
    expect(await prisma.attachment.findUnique({ where: { id: stale.id } })).not.toBeNull();

    // FAILED is aged from the moment it was marked, so it is removed an hour later, not in the next minute
    const soon = await reconcile(prisma, s.storage, { dryRun: false });
    expect(soon.staleFailed).not.toContain(stale.id);
    const second = await reconcile(prisma, s.storage, { dryRun: false, now: new Date(Date.now() + 2 * HOUR) });
    expect(second.staleFailed).toContain(stale.id);
    expect(await prisma.attachment.findUnique({ where: { id: stale.id } })).toBeNull();
  });

  it('removes old FAILED rows with their objects', async () => {
    const s = await setup();
    const failed = await s.row('FAILED', { createdAt: old });
    const recent = await s.row('FAILED', { createdAt: fresh });
    const report = await reconcile(prisma, s.storage, { dryRun: false, now });
    expect(report.staleFailed).toContain(failed.id);
    expect(report.staleFailed).not.toContain(recent.id);
    expect(await prisma.attachment.findUnique({ where: { id: failed.id } })).toBeNull();
    expect(s.storage.has(failed.objectKey)).toBe(false);
    expect(await prisma.attachment.findUnique({ where: { id: recent.id } })).not.toBeNull();
  });

  it('finishes a deletion that was interrupted', async () => {
    const s = await setup();
    const half = await s.row('DELETING', { createdAt: old });
    const report = await reconcile(prisma, s.storage, { dryRun: false, now });
    expect(report.staleDeleting).toContain(half.id);
    expect(await prisma.attachment.findUnique({ where: { id: half.id } })).toBeNull();
    expect(s.storage.has(half.objectKey)).toBe(false);
  });

  it('deletes old objects that no row knows about, but not young ones or ones that have a row', async () => {
    const s = await setup();
    const known = await s.row('READY', { createdAt: old });
    const orphan = s.keyOf('orphan-old');
    const young = s.keyOf('orphan-young');
    await s.storage.put(orphan, Buffer.from('x'), 'text/plain');
    s.storage.age(orphan, old);
    await s.storage.put(young, Buffer.from('x'), 'text/plain');
    s.storage.age(young, fresh);

    const report = await reconcile(prisma, s.storage, { dryRun: false, now });
    expect(report.orphanObjects).toContain(orphan);
    expect(report.orphanObjects).not.toContain(young);
    expect(s.storage.has(orphan)).toBe(false);
    expect(s.storage.has(young)).toBe(true); // may belong to an upload that is still being recorded
    expect(s.storage.has(known.objectKey)).toBe(true);
  });

  it('reports READY rows whose object has vanished, without touching them', async () => {
    const s = await setup();
    const lost = await s.row('READY', { createdAt: old, withObject: false });
    const report = await reconcile(prisma, s.storage, { dryRun: false, now });
    // the whole database is reconciled, so look for this test's row, not for an exact list
    expect(report.missingObjects).toContain(lost.id);
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: lost.id } })).state).toBe('READY');
  });

  it('changes nothing in a dry run, but reports the same findings', async () => {
    const s = await setup();
    const pending = await s.row('PENDING', { createdAt: old });
    const failed = await s.row('FAILED', { createdAt: old });
    const deleting = await s.row('DELETING', { createdAt: old });
    const orphan = s.keyOf('dry-orphan');
    await s.storage.put(orphan, Buffer.from('x'), 'text/plain');
    s.storage.age(orphan, old);

    const dry = await reconcile(prisma, s.storage, { dryRun: true, now });
    expect(dry.dryRun).toBe(true);
    expect(dry.stalePending).toContain(pending.id);
    expect(dry.staleFailed).toContain(failed.id);
    expect(dry.staleDeleting).toContain(deleting.id);
    expect(dry.orphanObjects).toContain(orphan);
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: pending.id } })).state).toBe('PENDING');
    expect(await prisma.attachment.count({ where: { id: { in: [failed.id, deleting.id] } } })).toBe(2);
    expect(s.storage.has(orphan)).toBe(true);
    expect(s.storage.has(pending.objectKey)).toBe(true);

    const real = await reconcile(prisma, s.storage, { dryRun: false, now });
    expect(real.stalePending).toContain(pending.id); // the dry run predicted what the real run did
  });

  it('is idempotent and records failures for the next run instead of stopping', async () => {
    const s = await setup();
    const stale = await s.row('DELETING', { createdAt: old });
    // fail only this row's object (the run also meets rows left by other tests)
    const realDelete = s.storage.delete.bind(s.storage);
    let down = true;
    s.storage.delete = async (key: string) => {
      if (down && key === stale.objectKey) throw new Error('provider down');
      return realDelete(key);
    };
    const first = await reconcile(prisma, s.storage, { dryRun: false, now });
    expect(first.errors).toContain(`deleting ${stale.id}`);
    expect(await prisma.attachment.findUnique({ where: { id: stale.id } })).not.toBeNull(); // not removed: object may still exist

    down = false; // the provider is back
    const second = await reconcile(prisma, s.storage, { dryRun: false, now });
    expect(second.errors).not.toContain(`deleting ${stale.id}`);
    expect(await prisma.attachment.findUnique({ where: { id: stale.id } })).toBeNull();

    const third = await reconcile(prisma, s.storage, { dryRun: false, now });
    expect(third.staleDeleting).not.toContain(stale.id); // nothing left to do for it
  });

  it('ages a row from its last state change: an old file that was only just being deleted is left alone', async () => {
    const s = await setup();
    const service = new AttachmentService(prisma, s.storage);
    const png = { originalName: 'a.png', declaredType: 'image/png', data: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('x')]) };
    const file = await service.upload(s.author.actor, s.comment.id, png);
    await prisma.attachment.update({ where: { id: file.id }, data: { createdAt: old } }); // uploaded long ago
    s.storage.age(file.objectKey, old);
    s.storage.failNext.delete = new Error('provider down');
    await expect(service.remove(s.author.actor, file.id)).rejects.toThrow(); // now DELETING, interrupted a moment ago

    const report = await reconcile(prisma, s.storage, { dryRun: false }); // real clock
    expect(report.staleDeleting).not.toContain(file.id);
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: file.id } })).state).toBe('DELETING');

    const later = await reconcile(prisma, s.storage, { dryRun: false, now: new Date(Date.now() + 2 * HOUR) });
    expect(later.staleDeleting).toContain(file.id); // an hour after the interruption it is finished
    expect(await prisma.attachment.findUnique({ where: { id: file.id } })).toBeNull();
  });

  it('cleans up after a real crash: a PENDING row whose upload never finished', async () => {
    const s = await setup();
    const storage = s.storage;
    const service = new AttachmentService(prisma, storage);
    // simulate: the row was reserved, the process died before (or after) the put
    const png = { originalName: 'a.png', declaredType: 'image/png', data: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('x')]) };
    const done = await service.upload(s.author.actor, s.comment.id, png);
    await prisma.attachment.update({ where: { id: done.id }, data: { state: 'PENDING', createdAt: old, stateChangedAt: old } });
    storage.age(done.objectKey, old);

    const report = await reconcile(prisma, storage, { dryRun: false, now });
    expect(report.stalePending).toContain(done.id);
    expect(storage.has(done.objectKey)).toBe(false);
  });
});
