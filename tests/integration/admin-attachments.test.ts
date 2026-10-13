import { PrismaClient } from '@prisma/client';
import type express from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CommentService } from '../../src/domain/comments/comment-service.js';
import { TicketService } from '../../src/domain/tickets/ticket-service.js';
import type { MemoryStorage } from '../../src/storage/memory-storage.js';
import { Fixtures } from './helpers/fixtures.js';
import { createTestApp, signIn } from './helpers/http.js';

const prisma = new PrismaClient();
const fx = new Fixtures(prisma);
const tickets = new TicketService(prisma);
const comments = new CommentService(prisma);
let app: express.Express;
let pool: Pool;
let storage: MemoryStorage;

let admin: Awaited<ReturnType<Fixtures['admin']>>;
let author: Awaited<ReturnType<Fixtures['agent']>>;
let colleague: Awaited<ReturnType<Fixtures['agent']>>;
let outsider: Awaited<ReturnType<Fixtures['agent']>>;
let groupA: Awaited<ReturnType<Fixtures['group']>>;
let customer: Awaited<ReturnType<Fixtures['customer']>>;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('image bytes')]);
const upload = (id: string) => `/internal/comments/${id}/attachments`;
const RESOLUTION = 'Restarted the sync job and verified';

beforeAll(async () => {
  await fx.init();
  ({ app, pool, storage } = await createTestApp(prisma));
  groupA = await fx.group();
  const groupB = await fx.group();
  customer = await fx.customer();
  admin = await fx.admin();
  author = await fx.agent([groupA]);
  colleague = await fx.agent([groupA]);
  outsider = await fx.agent([groupB]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM support."Session" WHERE sess->>'userId' = ANY($1::text[])`, [[admin.user.id, author.user.id, colleague.user.id, outsider.user.id]]);
  await fx.cleanup();
  await prisma.$disconnect();
  await pool.end();
});

/** An in-progress ticket and a comment by `author`. */
async function target() {
  const created = await tickets.create(admin.actor, { subject: 'Upload target', description: 'd', customerId: customer.id, groupId: groupA.id, assignedAgentId: author.agent.id });
  const ticket = await tickets.changeStatus(admin.actor, created.id, created.version, { targetStatus: 'IN_PROGRESS' });
  const comment = await comments.add(author.actor, ticket.id, { body: 'Comment with files' });
  return { ticket, comment };
}

describe('uploading', () => {
  it('stores a file posted as multipart, keeps a Cyrillic name and returns what the UI needs', async () => {
    const { comment } = await target();
    const s = await signIn(app, author.user.normalizedEmail);
    const res = await s.with('post', upload(comment.id)).attach('file', PNG, { filename: 'Скриншот ошибки.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Скриншот ошибки.png', size: PNG.length, contentType: 'image/png' });

    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row).toMatchObject({ state: 'READY', commentId: comment.id, createdByUserId: author.user.id });
    expect(storage.get(row.objectKey)!.equals(PNG)).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(row.objectKey); // the object key never leaves the server
  });

  it('writes nothing to the local disk: it works with an unusable temp directory', async () => {
    const { comment } = await target();
    const s = await signIn(app, author.user.normalizedEmail);
    const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    process.env.TMPDIR = process.env.TEMP = process.env.TMP = '/this/directory/does/not/exist';
    try {
      const res = await s.with('post', upload(comment.id)).attach('file', PNG, { filename: 'a.png', contentType: 'image/png' });
      expect(res.status).toBe(201);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('needs a session and the CSRF header, and stores nothing without them', async () => {
    const { comment } = await target();
    const before = storage.count;
    const s = await signIn(app, author.user.normalizedEmail);
    expect((await s.withoutToken('post', upload(comment.id)).attach('file', PNG, { filename: 'a.png', contentType: 'image/png' })).status).toBe(403);
    expect((await request(app).post(upload(comment.id)).attach('file', PNG, { filename: 'a.png', contentType: 'image/png' })).status).toBe(403);
    expect(storage.count).toBe(before);
    expect(await prisma.attachment.count({ where: { commentId: comment.id } })).toBe(0);
  });

  it('explains a refusal even when a large body is still on its way (no reset connection)', async () => {
    const { comment } = await target();
    const big = Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024)]);
    const s = await signIn(app, author.user.normalizedEmail);
    const res = await s.withoutToken('post', upload(comment.id)).attach('file', big, { filename: 'a.png', contentType: 'image/png' });
    expect(res.status).toBe(403); // CSRF refusal, delivered while the 4 MiB body is still arriving
    expect(await prisma.attachment.count({ where: { commentId: comment.id } })).toBe(0);
  });

  it('refuses a file over 10 MiB with 413 and keeps nothing', async () => {
    const { comment } = await target();
    const before = storage.count;
    const s = await signIn(app, author.user.normalizedEmail);
    const big = Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024)]);
    const res = await s.with('post', upload(comment.id)).attach('file', big, { filename: 'big.png', contentType: 'image/png' });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('file_too_large');
    expect(storage.count).toBe(before);
    expect(await prisma.attachment.count({ where: { commentId: comment.id } })).toBe(0);
  });

  it('refuses unsupported or mislabelled files with 415', async () => {
    const { comment } = await target();
    const s = await signIn(app, author.user.normalizedEmail);
    const post = (buf: Buffer, filename: string, contentType: string) => s.with('post', upload(comment.id)).attach('file', buf, { filename, contentType });
    expect((await post(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'logo.svg', 'image/svg+xml')).status).toBe(415);
    expect((await post(Buffer.from('MZ-fake-executable'), 'tool.png', 'image/png')).status).toBe(415);
    expect((await post(PNG, 'screen.png', 'application/pdf')).status).toBe(415);
    expect((await post(PNG, 'screen.txt', 'image/png')).status).toBe(415);
    expect(await prisma.attachment.count({ where: { commentId: comment.id } })).toBe(0);
  });

  it('accepts exactly one file in the "file" field and nothing else', async () => {
    const { comment } = await target();
    const s = await signIn(app, author.user.normalizedEmail);
    const none = await s.with('post', upload(comment.id)).send({});
    expect(none.status).toBe(415);
    const twoFiles = await s.with('post', upload(comment.id)).attach('file', PNG, { filename: 'a.png', contentType: 'image/png' }).attach('file', PNG, { filename: 'b.png', contentType: 'image/png' });
    expect(twoFiles.status).toBe(415);
    const wrongField = await s.with('post', upload(comment.id)).attach('document', PNG, { filename: 'a.png', contentType: 'image/png' });
    expect(wrongField.status).toBe(415);
    const withField = await s.with('post', upload(comment.id)).field('commentId', 'x').attach('file', PNG, { filename: 'a.png', contentType: 'image/png' });
    expect(withField.status).toBe(415);
    expect(await prisma.attachment.count({ where: { commentId: comment.id } })).toBe(0);
  });

  it('enforces who may attach, the status of the ticket and the limit of five', async () => {
    const { ticket, comment } = await target();
    const post = async (email: string) => (await signIn(app, email)).with('post', upload(comment.id)).attach('file', PNG, { filename: 'a.png', contentType: 'image/png' });

    expect((await post(colleague.user.normalizedEmail)).status).toBe(403);
    expect((await post(outsider.user.normalizedEmail)).status).toBe(404);
    for (let i = 0; i < 5; i++) expect((await post(author.user.normalizedEmail)).status, `upload ${i + 1}`).toBe(201);
    const sixth = await post(author.user.normalizedEmail);
    expect(sixth.status).toBe(409);
    expect(sixth.body.error).toBe('attachment_limit');

    const fresh = await target();
    const resolved = await tickets.changeStatus(admin.actor, fresh.ticket.id, fresh.ticket.version, { targetStatus: 'RESOLVED', resolution: RESOLUTION });
    await tickets.changeStatus(admin.actor, resolved.id, resolved.version, { targetStatus: 'CLOSED' });
    const closed = (await signIn(app, admin.user.normalizedEmail)).with('post', upload(fresh.comment.id)).attach('file', PNG, { filename: 'a.png', contentType: 'image/png' });
    expect((await closed).body.error).toBe('ticket_frozen');
    expect(ticket.id).not.toBe(fresh.ticket.id);
  });

  it('answers 429 instead of buffering when too many uploads run at once', async () => {
    const limited = await createTestApp(prisma, { env: { MAX_CONCURRENT_UPLOADS: '1' } });
    try {
      const { comment } = await target();
      const s = await signIn(limited.app, author.user.normalizedEmail);
      const body = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]);
      const results = await Promise.all(Array.from({ length: 4 }, () => s.with('post', upload(comment.id)).attach('file', body, { filename: 'a.png', contentType: 'image/png' })));
      const statuses = results.map((r) => r.status);
      expect(statuses).toContain(429);
      expect(statuses.every((c) => c === 201 || c === 429 || c === 409)).toBe(true);
      expect(results.find((r) => r.status === 429)!.body.error).toBe('busy');
    } finally {
      await limited.pool.end();
    }
  });
});

describe('downloading', () => {
  it('redirects to a short-lived attachment URL after checking access, and is not cached', async () => {
    const { comment } = await target();
    const a = await signIn(app, author.user.normalizedEmail);
    const created = (await a.with('post', upload(comment.id)).attach('file', PNG, { filename: 'Отчёт.png', contentType: 'image/png' })).body;
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: created.id } });

    const col = await signIn(app, colleague.user.normalizedEmail);
    const res = await col.get(`/internal/attachments/${created.id}/download`).redirects(0);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location!);
    expect(location.hostname).toBe('storage.test');
    expect(location.pathname).toContain(row.objectKey);
    expect(location.searchParams.get('expires')).toBe('60');
    expect(location.searchParams.get('disposition')).toMatch(/^attachment; filename="/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-content-type-options']).toBe('nosniff');

    expect((await (await signIn(app, outsider.user.normalizedEmail)).get(`/internal/attachments/${created.id}/download`).redirects(0)).status).toBe(404);
    expect((await request(app).get(`/internal/attachments/${created.id}/download`).redirects(0)).status).toBe(401);
    expect((await a.get('/internal/attachments/not-a-uuid/download').redirects(0)).status).toBe(404);
  });
});

describe('logging', () => {
  it('never writes download URLs, signatures or provider messages to the logs', async () => {
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' '))),
    );
    const realPresign = storage.presignGet.bind(storage);
    try {
      const { comment } = await target();
      const a = await signIn(app, author.user.normalizedEmail);
      const created = (await a.with('post', upload(comment.id)).attach('file', PNG, { filename: 'a.png', contentType: 'image/png' })).body;

      const ok = await a.get(`/internal/attachments/${created.id}/download`).redirects(0);
      expect(ok.status).toBe(302);

      storage.presignGet = async () => {
        throw new Error('signing failed for https://secret-host.example/bucket?X-Amz-Signature=abc123');
      };
      expect((await a.get(`/internal/attachments/${created.id}/download`).redirects(0)).status).toBe(502);
      storage.presignGet = realPresign;

      storage.failNext.put = new Error('put failed for https://secret-host.example/bucket?X-Amz-Signature=abc123');
      const failed = await a.with('post', upload(comment.id)).attach('file', PNG, { filename: 'b.png', contentType: 'image/png' });
      expect(failed.status).toBe(502);

      const logged = lines.join(' | ');
      expect(logged).not.toContain('X-Amz-Signature');
      expect(logged).not.toContain('secret-host');
      expect(logged).not.toContain(String(ok.headers.location).split('?')[0]);
    } finally {
      storage.presignGet = realPresign;
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});

describe('removing', () => {
  it('deletes with the CSRF header, for the author, and not for others', async () => {
    const { comment } = await target();
    const a = await signIn(app, author.user.normalizedEmail);
    const created = (await a.with('post', upload(comment.id)).attach('file', PNG, { filename: 'a.png', contentType: 'image/png' })).body;
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: created.id } });

    expect((await a.withoutToken('delete', `/internal/attachments/${created.id}`)).status).toBe(403);
    expect((await (await signIn(app, colleague.user.normalizedEmail)).with('delete', `/internal/attachments/${created.id}`)).status).toBe(403);
    expect((await (await signIn(app, outsider.user.normalizedEmail)).with('delete', `/internal/attachments/${created.id}`)).status).toBe(404);
    expect(storage.has(row.objectKey)).toBe(true);

    expect((await a.with('delete', `/internal/attachments/${created.id}`)).status).toBe(204);
    expect(storage.has(row.objectKey)).toBe(false);
    expect(await prisma.attachment.findUnique({ where: { id: created.id } })).toBeNull();
    expect((await a.with('delete', `/internal/attachments/${created.id}`)).status).toBe(404);
  });

  it('shows the files in the comment list and withdraws the controls once the ticket is closed', async () => {
    const { ticket, comment } = await target();
    const a = await signIn(app, author.user.normalizedEmail);
    await a.with('post', upload(comment.id)).attach('file', PNG, { filename: 'a.png', contentType: 'image/png' });
    const url = `/app/api/resources/Ticket/records/${ticket.id}/listComments`;
    expect((await a.get(url)).body.items[0]).toMatchObject({ attachments: [{ name: 'a.png' }], canAttach: true, canDeleteAttachments: true });

    const resolved = await tickets.changeStatus(admin.actor, ticket.id, ticket.version, { targetStatus: 'RESOLVED', resolution: RESOLUTION });
    await tickets.changeStatus(admin.actor, resolved.id, resolved.version, { targetStatus: 'CLOSED' });
    expect((await a.get(url)).body.items[0]).toMatchObject({ attachments: [{ name: 'a.png' }], canAttach: false, canDeleteAttachments: false });
  });
});
