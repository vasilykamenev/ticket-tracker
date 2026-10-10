import { PrismaClient } from '@prisma/client';
import type express from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommentService } from '../../src/domain/comments/comment-service.js';
import { TicketService } from '../../src/domain/tickets/ticket-service.js';
import { Fixtures } from './helpers/fixtures.js';
import { API, ORIGIN, createTestApp, signIn } from './helpers/http.js';

const prisma = new PrismaClient();
const fx = new Fixtures(prisma);
const tickets = new TicketService(prisma);
const comments = new CommentService(prisma);
let app: express.Express;
let pool: Pool;
let admin: Awaited<ReturnType<Fixtures['admin']>>;
let author: Awaited<ReturnType<Fixtures['agent']>>;
let colleague: Awaited<ReturnType<Fixtures['agent']>>;
let outsider: Awaited<ReturnType<Fixtures['agent']>>;
let groupA: Awaited<ReturnType<Fixtures['group']>>;
let groupB: Awaited<ReturnType<Fixtures['group']>>;
let customer: Awaited<ReturnType<Fixtures['customer']>>;

const RESOLUTION = 'Restarted the sync job and verified';
const url = (ticketId: string, action: string) => `${API}/Ticket/records/${ticketId}/${action}`;
/** AdminJS answers actions on records it cannot load (e.g. outside the scope) with HTTP 200 and a typed base error. */
const refusal = (res: { body: { record?: { baseError?: { type?: string } } } }) => res.body.record?.baseError?.type;

beforeAll(async () => {
  await fx.init();
  ({ app, pool } = await createTestApp(prisma));
  groupA = await fx.group();
  groupB = await fx.group();
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

const newTicket = async (groupId = groupA.id) => {
  const t = await tickets.create(admin.actor, { subject: 'Comment target', description: 'Details', customerId: customer.id, groupId, assignedAgentId: groupId === groupA.id ? author.agent.id : undefined });
  return t;
};

describe('adding and listing', () => {
  it('stores the comment for the signed-in user, whatever the payload claims', async () => {
    const t = await newTicket();
    const a = await signIn(app, author.user.normalizedEmail);
    const other = await newTicket();
    const res = await a.post(url(t.id, 'addComment'), { body: 'From the form', authorUserId: admin.user.id, ticketId: other.id, version: 7 });
    expect(res.status).toBe(200);
    const row = await prisma.comment.findFirstOrThrow({ where: { body: 'From the form' } });
    expect(row).toMatchObject({ ticketId: t.id, authorUserId: author.user.id, version: 1 });
    expect(await prisma.comment.count({ where: { ticketId: other.id } })).toBe(0);
  });

  it('lists a page with flags for this viewer and returns markup untouched', async () => {
    const t = await newTicket();
    await comments.add(author.actor, t.id, { body: '<script>alert(1)</script>' });
    await comments.add(admin.actor, t.id, { body: 'By an administrator' });

    const a = await signIn(app, author.user.normalizedEmail);
    const view = await a.get(url(t.id, 'listComments'));
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ total: 2, canAdd: true });
    expect(view.body.items.map((i: { body: string; canEdit: boolean }) => [i.body, i.canEdit])).toEqual([
      ['<script>alert(1)</script>', true], // stored as text; the component renders text nodes
      ['By an administrator', false],
    ]);
  });

  it('pages by ten', async () => {
    const t = await newTicket();
    for (let i = 1; i <= 11; i++) await comments.add(author.actor, t.id, { body: `Comment ${i}` });
    const s = await signIn(app, admin.user.normalizedEmail);
    expect((await s.get(url(t.id, 'listComments'))).body.items).toHaveLength(10);
    const second = await s.get(`${url(t.id, 'listComments')}?page=2`);
    expect(second.body.items.map((i: { body: string }) => i.body)).toEqual(['Comment 11']);
  });

  it('needs the CSRF token and a session', async () => {
    const t = await newTicket();
    const anonymous = request.agent(app);
    expect((await anonymous.post(url(t.id, 'addComment')).set('Origin', ORIGIN).send({ body: 'Forged' })).status).toBe(403);
    expect((await request(app).get(url(t.id, 'listComments'))).status).toBe(401);
    expect(await prisma.comment.count({ where: { ticketId: t.id } })).toBe(0);
  });

  it('shows validation messages for empty and over-long text', async () => {
    const t = await newTicket();
    const a = await signIn(app, author.user.normalizedEmail);
    const empty = await a.post(url(t.id, 'addComment'), { body: '   ' });
    expect(empty.status).toBe(422);
    expect(Object.keys(empty.body.details)).toContain('body');
    expect((await a.post(url(t.id, 'addComment'), { body: 'x'.repeat(5001) })).status).toBe(422);
  });
});

describe('scope', () => {
  it('is invisible for tickets of other groups, for reading and writing', async () => {
    const foreign = await newTicket(groupB.id);
    const a = await signIn(app, author.user.normalizedEmail);
    expect(refusal(await a.get(url(foreign.id, 'listComments')))).toBe('NotFoundError');
    expect(refusal(await a.post(url(foreign.id, 'addComment'), { body: 'Not mine' }))).toBe('NotFoundError');
    expect(await prisma.comment.count({ where: { ticketId: foreign.id } })).toBe(0);
  });

  it('refuses editing a comment of a ticket in another group', async () => {
    const t = await newTicket();
    const c = await comments.add(author.actor, t.id, { body: 'Group A only' });
    const o = await signIn(app, outsider.user.normalizedEmail);
    const res = await o.post(url(t.id, 'editComment'), { commentId: c.id, version: c.version, body: 'Hijacked' });
    expect(refusal(res)).toBe('NotFoundError'); // the outsider cannot even load the ticket
    const direct = await o.post(url((await newTicket(groupB.id)).id, 'editComment'), { commentId: c.id, version: c.version, body: 'Hijacked' });
    expect(direct.status).toBe(404); // naming a comment of another group through a ticket they can see
    expect((await prisma.comment.findUniqueOrThrow({ where: { id: c.id } })).body).toBe('Group A only');
  });
});

describe('editing', () => {
  it('lets the author edit, with HTTP statuses for conflicts and permissions', async () => {
    const t = await newTicket();
    const c = await comments.add(author.actor, t.id, { body: 'Original' });
    const a = await signIn(app, author.user.normalizedEmail);

    expect((await a.post(url(t.id, 'editComment'), { commentId: c.id, version: c.version, body: 'Edited' })).status).toBe(200);
    expect(await prisma.comment.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ body: 'Edited', version: 2 });

    const stale = await a.post(url(t.id, 'editComment'), { commentId: c.id, version: c.version, body: 'Stale' });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('version_conflict');

    const col = await signIn(app, colleague.user.normalizedEmail);
    const notMine = await col.post(url(t.id, 'editComment'), { commentId: c.id, version: 2, body: 'Not mine' });
    expect(notMine.status).toBe(403);
    expect(notMine.body.error).toBe('not_author');

    const s = await signIn(app, admin.user.normalizedEmail);
    expect((await s.post(url(t.id, 'editComment'), { commentId: c.id, version: 2, body: 'Fixed by an administrator' })).status).toBe(200);
  });

  it('is refused for everyone once the ticket is closed, while staying readable', async () => {
    const t = await newTicket();
    const c = await comments.add(author.actor, t.id, { body: 'Written while open' });
    const started = await tickets.changeStatus(admin.actor, t.id, t.version, { targetStatus: 'IN_PROGRESS' });
    const resolved = await tickets.changeStatus(admin.actor, started.id, started.version, { targetStatus: 'RESOLVED', resolution: RESOLUTION });
    await tickets.changeStatus(admin.actor, resolved.id, resolved.version, { targetStatus: 'CLOSED' });

    for (const email of [admin.user.normalizedEmail, author.user.normalizedEmail]) {
      const s = await signIn(app, email);
      const edit = await s.post(url(t.id, 'editComment'), { commentId: c.id, version: c.version, body: 'Rewriting history' });
      expect(edit.status, email).toBe(409);
      expect(edit.body.error).toBe('ticket_frozen');
      expect((await s.post(url(t.id, 'addComment'), { body: 'Too late' })).body.error).toBe('ticket_frozen');
      const view = await s.get(url(t.id, 'listComments'));
      expect(view.body).toMatchObject({ canAdd: false, total: 1 });
      expect(view.body.items[0]).toMatchObject({ body: 'Written while open', canEdit: false });
    }
  });
});
