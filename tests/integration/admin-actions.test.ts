import { PrismaClient } from '@prisma/client';
import type express from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TicketService } from '../../src/domain/tickets/ticket-service.js';
import { Fixtures } from './helpers/fixtures.js';
import { API, ORIGIN, createTestApp, signIn } from './helpers/http.js';

const prisma = new PrismaClient();
const fx = new Fixtures(prisma);
const tickets = new TicketService(prisma);
let app: express.Express;
let pool: Pool;

const RESOLUTION = 'Restarted the sync job and verified';

let groupA: Awaited<ReturnType<Fixtures['group']>>;
let groupB: Awaited<ReturnType<Fixtures['group']>>;
let admin: Awaited<ReturnType<Fixtures['admin']>>;
let agentA: Awaited<ReturnType<Fixtures['agent']>>;
let agentA2: Awaited<ReturnType<Fixtures['agent']>>;
let agentB: Awaited<ReturnType<Fixtures['agent']>>;
let customer: Awaited<ReturnType<Fixtures['customer']>>;

beforeAll(async () => {
  await fx.init();
  ({ app, pool } = await createTestApp(prisma));
  groupA = await fx.group();
  groupB = await fx.group();
  admin = await fx.admin();
  agentA = await fx.agent([groupA]);
  agentA2 = await fx.agent([groupA]);
  agentB = await fx.agent([groupB]);
  customer = await fx.customer();
});

afterAll(async () => {
  await pool.query(`DELETE FROM support."Session" WHERE sess->>'userId' = ANY($1::text[])`, [[admin.user.id, agentA.user.id, agentA2.user.id, agentB.user.id]]);
  await fx.cleanup();
  await prisma.$disconnect();
  await pool.end();
});

const newTicket = (groupId: string, subject: string, extra: object = {}) =>
  tickets.create(admin.actor, { subject, description: 'Details', customerId: customer.id, groupId, ...extra });

const action = (id: string, name: string) => `${API}/Ticket/records/${id}/${name}`;
/** AdminJS answers actions on records it cannot load (e.g. outside the scope) with HTTP 200 and a typed base error. */
const refusal = (res: { body: { record?: { baseError?: { type?: string } } } }) => res.body.record?.baseError?.type;

describe('changeStatus action', () => {
  it('changes the status through the service and records history', async () => {
    const t = await newTicket(groupA.id, 'Status via action', { assignedAgentId: agentA.agent.id });
    const a = await signIn(app, agentA.user.normalizedEmail);
    const res = await a.post(action(t.id, 'changeStatus'), { version: t.version, targetStatus: 'IN_PROGRESS' });
    expect(res.status).toBe(200);
    const after = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id }, include: { status: true } });
    expect(after.status.code).toBe('IN_PROGRESS');
    expect(after.version).toBe(t.version + 1);
    expect(await prisma.ticketHistory.count({ where: { ticketId: t.id, kind: 'STATUS_CHANGED' } })).toBe(1);
  });

  it('answers with HTTP statuses and field details the form can show', async () => {
    const t = await newTicket(groupA.id, 'Errors via action', { assignedAgentId: agentA.agent.id });
    const a = await signIn(app, agentA.user.normalizedEmail);
    await a.post(action(t.id, 'changeStatus'), { version: t.version, targetStatus: 'IN_PROGRESS' });

    const stale = await a.post(action(t.id, 'changeStatus'), { version: t.version, targetStatus: 'WAITING_CUSTOMER', reason: 'Asked for logs' });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('version_conflict');

    const missing = await a.post(action(t.id, 'changeStatus'), { version: t.version + 1, targetStatus: 'RESOLVED', resolution: 'short' });
    expect(missing.status).toBe(422);
    expect(Object.keys(missing.body.details)).toContain('resolution');

    const bad = await a.post(action(t.id, 'changeStatus'), { version: t.version + 1, targetStatus: 'CLOSED' });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe('invalid_transition');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id }, include: { status: true } })).status.code).toBe('IN_PROGRESS');
  });

  it('keeps ADMIN-only transitions from agents and hides foreign tickets', async () => {
    const t = await newTicket(groupA.id, 'Close attempt', { assignedAgentId: agentA.agent.id });
    const s = await signIn(app, admin.user.normalizedEmail);
    await s.post(action(t.id, 'changeStatus'), { version: t.version, targetStatus: 'IN_PROGRESS' });
    await s.post(action(t.id, 'changeStatus'), { version: t.version + 1, targetStatus: 'RESOLVED', resolution: RESOLUTION });
    const v = t.version + 2;

    const a = await signIn(app, agentA.user.normalizedEmail);
    const close = await a.post(action(t.id, 'changeStatus'), { version: v, targetStatus: 'CLOSED' });
    expect(close.status).toBe(403);
    expect(close.body.error).toBe('admin_only');

    const foreign = await newTicket(groupB.id, 'Foreign ticket');
    const hidden = await a.post(action(foreign.id, 'changeStatus'), { version: foreign.version, targetStatus: 'IN_PROGRESS' });
    expect(refusal(hidden)).toBe('NotFoundError');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: foreign.id }, include: { status: true } })).status.code).toBe('NEW');
  });

  it('needs the CSRF token like every other mutation', async () => {
    const t = await newTicket(groupA.id, 'CSRF check', { assignedAgentId: agentA.agent.id });
    const anonymous = request.agent(app); // no session, no token
    const forged = await anonymous.post(action(t.id, 'changeStatus')).set('Origin', ORIGIN).send({ version: t.version, targetStatus: 'IN_PROGRESS' });
    expect(forged.status).toBe(403);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id }, include: { status: true } })).status.code).toBe('NEW');
  });
});

describe('assignTicket action', () => {
  it('reassigns within the group and moves a ticket with a member of the new group', async () => {
    const t = await newTicket(groupA.id, 'Assign via action');
    const s = await signIn(app, admin.user.normalizedEmail);
    const assigned = await s.post(action(t.id, 'assignTicket'), { version: t.version, assignedAgentId: agentA.agent.id });
    expect(assigned.status).toBe(200);
    const moved = await s.post(action(t.id, 'assignTicket'), { version: t.version + 1, groupId: groupB.id, assignedAgentId: agentB.agent.id });
    expect(moved.status).toBe(200);
    const after = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.groupId).toBe(groupB.id);
    expect(after.assignedAgentId).toBe(agentB.agent.id);
  });

  it('rejects a non-member with a field error and an agent moving a ticket to a foreign group with 403', async () => {
    const t = await newTicket(groupA.id, 'Assign errors');
    const a = await signIn(app, agentA.user.normalizedEmail);
    const outsider = await a.post(action(t.id, 'assignTicket'), { version: t.version, assignedAgentId: agentB.agent.id });
    expect(outsider.status).toBe(422);
    expect(Object.keys(outsider.body.details)).toContain('assignedAgentId');
    const foreignGroup = await a.post(action(t.id, 'assignTicket'), { version: t.version, groupId: groupB.id, assignedAgentId: agentB.agent.id });
    expect(foreignGroup.status).toBe(403);
  });
});

describe('formState and history actions', () => {
  it('returns scoped form data and readable history', async () => {
    const t = await newTicket(groupA.id, 'Form data', { assignedAgentId: agentA.agent.id });
    const a = await signIn(app, agentA.user.normalizedEmail);
    const state = await a.get(`${action(t.id, 'formState')}`);
    expect(state.status).toBe(200);
    expect(state.body.ticket).toMatchObject({ id: t.id, version: t.version, statusCode: 'NEW', groupName: groupA.name });
    expect(state.body.agents.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining([agentA.agent.id, agentA2.agent.id]));
    expect(state.body.groups.map((x: { id: string }) => x.id)).toEqual([groupA.id]);

    const history = await a.get(`${action(t.id, 'history')}?page=1`);
    expect(history.body.total).toBe(1);
    expect(history.body.items[0].kind).toBe('CREATED');
  });

  it('is 404 for tickets outside the scope and refuses a foreign group for agents', async () => {
    const own = await newTicket(groupA.id, 'Own ticket');
    const foreign = await newTicket(groupB.id, 'Other group');
    const a = await signIn(app, agentA.user.normalizedEmail);
    expect(refusal(await a.get(action(foreign.id, 'formState')))).toBe('NotFoundError');
    expect(refusal(await a.get(action(foreign.id, 'history')))).toBe('NotFoundError');
    expect((await a.get(`${action(own.id, 'formState')}?groupId=${groupB.id}`)).status).toBe(403);
  });

  it('requires a signed-in user', async () => {
    const t = await newTicket(groupA.id, 'Anonymous');
    expect((await request(app).get(action(t.id, 'history'))).status).toBe(401);
  });
});

describe('ticket show page extras', () => {
  it('includes a computed age and never stores it', async () => {
    const t = await newTicket(groupA.id, 'Aged ticket');
    const s = await signIn(app, admin.user.normalizedEmail);
    const shown = await s.get(`${API}/Ticket/records/${t.id}/show`);
    expect(shown.body.record.params.age).toMatch(/^(<1m|\d+[mhd])/);
    expect(await prisma.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_schema = 'support' AND table_name = 'Ticket' AND column_name = 'age'`).toEqual([]);
  });
});

describe('customer tickets and dashboard', () => {
  it('lists a customer\'s tickets limited to the viewer\'s groups', async () => {
    const own = await newTicket(groupA.id, 'Visible to A');
    const foreign = await newTicket(groupB.id, 'Hidden from A');
    const a = await signIn(app, agentA.user.normalizedEmail);
    const res = await a.get(`${API}/Customer/records/${customer.id}/customerTickets`);
    const subjects = (res.body.items as { subject: string }[]).map((i) => i.subject);
    expect(subjects).toContain('Visible to A');
    expect(subjects).not.toContain('Hidden from A');
    const s = await signIn(app, admin.user.normalizedEmail);
    const all = await s.get(`${API}/Customer/records/${customer.id}/customerTickets?page=1`);
    expect(all.body.total).toBeGreaterThan(res.body.total);
    expect(own.id).not.toBe(foreign.id);
  });

  it('gives each viewer counts for their own scope', async () => {
    const lone = await fx.group();
    const worker = await fx.agent([lone]);
    await newTicket(lone.id, 'Lone one');
    await newTicket(lone.id, 'Lone two', { assignedAgentId: worker.agent.id });
    const w = await signIn(app, worker.user.normalizedEmail);
    const res = await w.get('/app/api/dashboard');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 2, unassigned: 1, mine: { count: 1, agentId: worker.agent.id } });
    await pool.query(`DELETE FROM support."Session" WHERE sess->>'userId' = $1`, [worker.user.id]);
  });
});
