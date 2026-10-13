import { PrismaClient } from '@prisma/client';
import type express from 'express';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TicketService } from '../../src/domain/tickets/ticket-service.js';
import { Fixtures } from './helpers/fixtures.js';
import { API, createTestApp, signIn } from './helpers/http.js';

const prisma = new PrismaClient();
const fx = new Fixtures(prisma);
const tickets = new TicketService(prisma);
let app: express.Express;
let pool: Pool;

let groupA: Awaited<ReturnType<Fixtures['group']>>;
let groupB: Awaited<ReturnType<Fixtures['group']>>;
let admin: Awaited<ReturnType<Fixtures['admin']>>;
let agentA: Awaited<ReturnType<Fixtures['agent']>>;
let agentB: Awaited<ReturnType<Fixtures['agent']>>;
let customer: Awaited<ReturnType<Fixtures['customer']>>;

beforeAll(async () => {
  await fx.init();
  ({ app, pool } = await createTestApp(prisma));
  groupA = await fx.group();
  groupB = await fx.group();
  admin = await fx.admin();
  agentA = await fx.agent([groupA]);
  agentB = await fx.agent([groupB]);
  customer = await fx.customer();
});

afterAll(async () => {
  await pool.query(`DELETE FROM support."Session" WHERE sess->>'userId' = ANY($1::text[])`, [[admin.user.id, agentA.user.id, agentB.user.id]]);
  await fx.cleanup();
  await prisma.$disconnect();
  await pool.end();
});

const make = async (count = 1) => {
  const created = [];
  for (let i = 0; i < count; i++) {
    created.push(await tickets.create(admin.actor, { subject: `Redesign ticket ${i + 1}`, description: 'd', customerId: customer.id, groupId: groupA.id, assignedAgentId: agentA.agent.id }));
  }
  return created;
};
/** AdminJS answers actions on records it cannot load (outside the scope) with HTTP 200 and a typed base error. */
const refusal = (res: { body: { record?: { baseError?: { type?: string } } } }) => res.body.record?.baseError?.type;
const action = (id: string, name: string) => `${API}/Ticket/records/${id}/${name}`;
const bulk = (ids: string[], name: string) => `${API}/Ticket/bulk/${name}?recordIds=${ids.join(',')}`;
const pairs = (list: Array<{ id: string; version: number }>) => list.map((t) => ({ id: t.id, version: t.version }));

describe('ticket page actions', () => {
  it('setPriority changes the priority, writes history and needs the CSRF token', async () => {
    const [t] = await make();
    const a = await signIn(app, agentA.user.normalizedEmail);
    const res = await a.post(action(t!.id, 'setPriority'), { version: t!.version, priority: 'URGENT' });
    expect(res.status).toBe(200);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t!.id } })).priority).toBe('URGENT');
    expect(await prisma.ticketHistory.count({ where: { ticketId: t!.id, kind: 'UPDATED' } })).toBe(1);
    const noToken = await a.withoutToken('post', action(t!.id, 'setPriority')).send({ version: t!.version + 1, priority: 'LOW' });
    expect(noToken.status).toBe(403);
  });

  it('setPriority hides tickets of other groups', async () => {
    const [t] = await make();
    const b = await signIn(app, agentB.user.normalizedEmail);
    const res = await b.post(action(t!.id, 'setPriority'), { version: t!.version, priority: 'LOW' });
    expect(refusal(res)).toBe('NotFoundError');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t!.id } })).priority).toBe('NORMAL');
  });

  it('addComment returns the id of the new comment, and nothing else of it', async () => {
    const [t] = await make();
    const a = await signIn(app, agentA.user.normalizedEmail);
    const res = await a.post(action(t!.id, 'addComment'), { body: 'First reply' });
    expect(res.status).toBe(200);
    const stored = await prisma.comment.findFirstOrThrow({ where: { ticketId: t!.id } });
    expect(res.body.commentId).toBe(stored.id);
    expect(res.body.body).toBeUndefined();
  });

  it('timeline merges the comments and the history events in time order', async () => {
    const [t] = await make();
    const a = await signIn(app, agentA.user.normalizedEmail);
    await a.post(action(t!.id, 'addComment'), { body: 'Looking into it' });
    await a.post(action(t!.id, 'changeStatus'), { version: t!.version, targetStatus: 'IN_PROGRESS' });
    const res = await a.get(action(t!.id, 'timeline'));
    expect(res.status).toBe(200);
    const kinds = res.body.entries.map((e: { type: string; event?: { kind: string } }) => (e.type === 'event' ? e.event!.kind : 'COMMENT'));
    expect(kinds).toEqual(['CREATED', 'COMMENT', 'STATUS_CHANGED']);
    const times = res.body.entries.map((e: { at: string }) => e.at);
    expect([...times].sort()).toEqual(times);
    expect(res.body.canAdd).toBe(true);
  });

  it('timeline is not available for a ticket of another group', async () => {
    const [t] = await make();
    const b = await signIn(app, agentB.user.normalizedEmail);
    const res = await b.get(action(t!.id, 'timeline'));
    expect(refusal(res)).toBe('NotFoundError');
    expect(res.body.entries).toBeUndefined();
  });
});

describe('new ticket form data', () => {
  it('lists the groups the viewer may use with their members, and suggests the group of the customer', async () => {
    await make();
    const a = await signIn(app, agentA.user.normalizedEmail);
    const res = await a.get(`${API}/Ticket/actions/newFormState?customerId=${customer.id}`);
    expect(res.status).toBe(200);
    expect(res.body.groups.map((g: { id: string }) => g.id)).toEqual([groupA.id]);
    expect(res.body.agentsByGroup[groupA.id].map((x: { id: string }) => x.id)).toContain(agentA.agent.id);
    expect(res.body.suggestedGroupId).toBe(groupA.id);
  });

  it('suggests nothing when the customer has no ticket the viewer can use', async () => {
    await make();
    const b = await signIn(app, agentB.user.normalizedEmail);
    const res = await b.get(`${API}/Ticket/actions/newFormState?customerId=${customer.id}`);
    expect(res.body.suggestedGroupId).toBeNull();
  });
});

describe('bulk assign, change group and change priority over HTTP', () => {
  it('opens each form with the selection, the groups and their members', async () => {
    const batch = await make(2);
    const a = await signIn(app, agentA.user.normalizedEmail);
    for (const name of ['bulkAssign', 'bulkChangeGroup', 'bulkChangePriority']) {
      const res = await a.get(bulk(batch.map((t) => t.id), name));
      expect(res.status, name).toBe(200);
      expect(res.body.records, name).toHaveLength(2);
      expect(res.body.tickets, name).toHaveLength(2);
      expect(res.body.sharedGroupId, name).toBe(groupA.id);
    }
  });

  it('assigns five selected tickets and writes five history entries', async () => {
    const batch = await make(5);
    const other = await fx.agent([groupA]);
    const a = await signIn(app, admin.user.normalizedEmail);
    const res = await a.post(bulk(batch.map((t) => t.id), 'bulkAssign'), { items: pairs(batch), groupId: groupA.id, assignedAgentId: other.agent.id });
    expect(res.status).toBe(200);
    expect(res.body.changed).toHaveLength(5);
    for (const t of batch) {
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).assignedAgentId).toBe(other.agent.id);
      expect(await prisma.ticketHistory.count({ where: { ticketId: t.id, kind: 'ASSIGNED' } })).toBe(1);
    }
  });

  it('changes the priority of the selected tickets, and refuses without the CSRF token', async () => {
    const batch = await make(2);
    const a = await signIn(app, agentA.user.normalizedEmail);
    const noToken = await a.withoutToken('post', bulk(batch.map((t) => t.id), 'bulkChangePriority')).send({ items: pairs(batch), priority: 'HIGH' });
    expect(noToken.status).toBe(403);
    const ok = await a.post(bulk(batch.map((t) => t.id), 'bulkChangePriority'), { items: pairs(batch), priority: 'HIGH' });
    expect(ok.status).toBe(200);
    for (const t of batch) expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).priority).toBe('HIGH');
  });

  it('names the refused tickets with HTTP 409 and changes nothing', async () => {
    const [first, stale] = await make(2);
    await tickets.update(admin.actor, stale!.id, stale!.version, { priority: 'LOW' });
    const a = await signIn(app, agentA.user.normalizedEmail);
    const res = await a.post(bulk([first!.id, stale!.id], 'bulkChangePriority'), { items: pairs([first!, stale!]), priority: 'URGENT' });
    expect(res.status).toBe(409);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: first!.id } })).priority).toBe('NORMAL');
  });
});

describe('dashboard over HTTP', () => {
  it('carries the queue, the distribution and the 14-day chart for the viewer', async () => {
    await make(2);
    const a = await signIn(app, agentA.user.normalizedEmail);
    const res = await a.get('/app/api/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.mineOpen).toBeGreaterThanOrEqual(2);
    expect(res.body.queue.length).toBeGreaterThanOrEqual(2);
    expect(res.body.incoming).toHaveLength(14);
    expect(res.body.byGroup.map((g: { id: string }) => g.id)).toEqual([groupA.id]);
  });
});
