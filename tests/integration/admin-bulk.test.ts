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

const make = async (count: number, groupId = groupA.id, assignee = agentA.agent.id) => {
  const created = [];
  for (let i = 0; i < count; i++) {
    created.push(await tickets.create(admin.actor, { subject: `Bulk via HTTP ${i + 1}`, description: 'd', customerId: customer.id, groupId, assignedAgentId: assignee }));
  }
  return created;
};
const bulk = (ids: string[], name = 'bulkChangeStatus') => `${API}/Ticket/bulk/${name}?recordIds=${ids.join(',')}`;
const pairs = (list: Array<{ id: string; version: number }>) => list.map((t) => ({ id: t.id, version: t.version }));
const statusOf = async (id: string) => (await prisma.ticket.findUniqueOrThrow({ where: { id }, include: { status: true } })).status.code;

describe('bulkChangeStatus over HTTP', () => {
  it('opens with the selected tickets, their versions and the changes valid for all of them', async () => {
    const batch = await make(2);
    const a = await signIn(app, agentA.user.normalizedEmail);
    const res = await a.get(bulk(batch.map((t) => t.id)));
    expect(res.status).toBe(200);
    expect(res.body.records).toHaveLength(2);
    expect(res.body.tickets.map((t: { number: number }) => t.number).sort()).toEqual(batch.map((t) => t.number).sort());
    expect(res.body.tickets[0]).toHaveProperty('version');
    expect(res.body.targets.map((t: { code: string }) => t.code)).toEqual(['IN_PROGRESS']);
    expect(res.body.unavailable).toBe(0);
  });

  it('offers only changes valid for every selected status, and ADMIN-only ones only to an admin', async () => {
    const [t] = await make(1);
    const working = await tickets.changeStatus(admin.actor, t!.id, t!.version, { targetStatus: 'IN_PROGRESS' });
    const solved = await tickets.changeStatus(admin.actor, working.id, working.version, { targetStatus: 'RESOLVED', resolution: 'Restarted the sync job and verified' });
    const [fresh] = await make(1);
    const [busy] = await make(1);
    const started = await tickets.changeStatus(admin.actor, busy!.id, busy!.version, { targetStatus: 'IN_PROGRESS' });

    const a = await signIn(app, agentA.user.normalizedEmail);
    const mixed = await a.get(bulk([solved.id, fresh!.id]));
    // RESOLVED and NEW share IN_PROGRESS; the reason is required because reopening a resolved ticket needs one.
    expect(mixed.body.targets).toMatchObject([{ code: 'IN_PROGRESS', reason: 'required' }]);
    const disjoint = await a.get(bulk([started.id, fresh!.id]));
    expect(disjoint.body.targets).toEqual([]); // IN_PROGRESS and NEW have no target in common
    const asAgent = await a.get(bulk([solved.id]));
    expect(asAgent.body.targets.map((x: { code: string }) => x.code)).toEqual(['IN_PROGRESS']); // CLOSED is ADMIN-only
    const asAdmin = await (await signIn(app, admin.user.normalizedEmail)).get(bulk([solved.id]));
    expect(asAdmin.body.targets.map((x: { code: string }) => x.code).sort()).toEqual(['CLOSED', 'IN_PROGRESS']);
  });

  it('hides tickets of other groups: nothing to open, and out-of-scope ids are only counted', async () => {
    const [mine] = await make(1);
    const [theirs] = await make(1, groupB.id, agentB.agent.id);
    const a = await signIn(app, agentA.user.normalizedEmail);
    expect((await a.get(bulk([theirs!.id]))).status).toBe(404);
    const mixed = await a.get(bulk([mine!.id, theirs!.id]));
    expect(mixed.body.tickets).toHaveLength(1);
    expect(mixed.body.unavailable).toBe(1);
  });

  it('changes the tickets on POST with the CSRF header, and refuses without it', async () => {
    const batch = await make(3);
    const a = await signIn(app, agentA.user.normalizedEmail);
    const body = { items: pairs(batch), targetStatus: 'IN_PROGRESS', reason: 'Taking the whole queue' };

    const noToken = await a.withoutToken('post', bulk(batch.map((t) => t.id))).send(body);
    expect(noToken.status).toBe(403);
    expect(await statusOf(batch[0]!.id)).toBe('NEW');

    const ok = await a.post(bulk(batch.map((t) => t.id)), body);
    expect(ok.status).toBe(200);
    expect(ok.body.changed).toHaveLength(3);
    for (const t of batch) expect(await statusOf(t.id)).toBe('IN_PROGRESS');
  });

  it('rolls everything back and names the refused tickets, with HTTP 409 and per-ticket details', async () => {
    const [a1, stale, a3] = await make(3);
    await tickets.update(admin.actor, stale!.id, stale!.version, { priority: 'HIGH' });
    const a = await signIn(app, agentA.user.normalizedEmail);
    const res = await a.post(bulk([a1!.id, stale!.id, a3!.id]), { items: pairs([a1!, stale!, a3!]), targetStatus: 'IN_PROGRESS' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('bulk_rejected');
    expect(Object.keys(res.body.details)).toEqual([`Ticket #${stale!.number}`]);
    expect(await statusOf(a1!.id)).toBe('NEW');
    expect(await statusOf(a3!.id)).toBe('NEW');
  });

  it('answers 422 for more than 100 tickets and for unknown fields', async () => {
    const [t] = await make(1);
    const a = await signIn(app, agentA.user.normalizedEmail);
    const many = Array.from({ length: 101 }, () => ({ id: crypto.randomUUID(), version: 1 }));
    const tooMany = await a.post(bulk([t!.id]), { items: many, targetStatus: 'IN_PROGRESS' });
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.error).toBe('batch_too_large');
    const extra = await a.post(bulk([t!.id]), { items: pairs([t!]), targetStatus: 'IN_PROGRESS', assignedAgentId: agentA.agent.id });
    expect(extra.status).toBe(422);
    expect(await statusOf(t!.id)).toBe('NEW');
  });

  it('refuses an oversized selection in the query before AdminJS loads a single record', async () => {
    const a = await signIn(app, agentA.user.normalizedEmail);
    const ids = Array.from({ length: 101 }, () => crypto.randomUUID());
    const get = await a.get(bulk(ids));
    expect(get.status).toBe(422);
    expect(get.body.error).toBe('batch_too_large');
    const post = await a.post(bulk(ids), { items: [{ id: ids[0], version: 1 }], targetStatus: 'IN_PROGRESS' });
    expect(post.status).toBe(422);
    expect(post.body.error).toBe('batch_too_large');
    const repeated = await a.get(bulk([...ids.slice(0, 100), ids[0]!])); // 101 entries but 100 distinct: not too large (and not found)
    expect(repeated.status).toBe(404);
    const array = await a.get(`${API}/Ticket/bulk/bulkChangeStatus?recordIds=${ids[0]}&recordIds=${ids[1]}`);
    expect(array.status).toBe(422);
  });

  it('tells the form which tickets have no assignee and which changes need one', async () => {
    const [unassigned] = [await tickets.create(admin.actor, { subject: 'No assignee yet', description: 'd', customerId: customer.id, groupId: groupA.id })];
    const [assigned] = await make(1);
    const a = await signIn(app, agentA.user.normalizedEmail);
    const res = await a.get(bulk([unassigned.id, assigned!.id]));
    expect(res.status).toBe(200);
    const byId = new Map(res.body.tickets.map((t: { id: string; assigned: boolean }) => [t.id, t.assigned]));
    expect(byId.get(unassigned.id)).toBe(false);
    expect(byId.get(assigned!.id)).toBe(true);
    expect(res.body.targets).toMatchObject([{ code: 'IN_PROGRESS', needsAssignee: true }]);

    const refused = await a.post(bulk([unassigned.id, assigned!.id]), { items: pairs([unassigned, assigned!]), targetStatus: 'IN_PROGRESS' });
    expect(refused.status).toBe(409);
    expect(Object.keys(refused.body.details)).toEqual([`Ticket #${unassigned.number}`]); // the assigned one is only rolled back
  });

  it('keeps bulk delete switched off', async () => {
    const [t] = await make(1);
    const a = await signIn(app, admin.user.normalizedEmail);
    const res = await a.post(bulk([t!.id], 'bulkDelete'), {});
    expect(res.body.record?.baseError?.type).toBe('ForbiddenError'); // AdminJS answers a forbidden action with HTTP 200 and this body
    expect(await prisma.ticket.count({ where: { id: t!.id } })).toBe(1);
  });
});
