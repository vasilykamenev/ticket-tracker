import { PrismaClient } from '@prisma/client';
import type express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createSessionPool } from '../../src/auth/session.js';
import { loadEnv } from '../../src/config/env.js';
import { TicketService } from '../../src/domain/tickets/ticket-service.js';
import { Fixtures, TEST_PASSWORD } from './helpers/fixtures.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests (see .env.example)');

const ORIGIN = 'http://localhost:3000';
const env = loadEnv({
  APP_ENV: 'test',
  PUBLIC_URL: ORIGIN,
  DATABASE_URL: databaseUrl,
  SESSION_SECRET: 'integration-test-secret-integration-test',
  LOGIN_MAX_PER_IP: '1000',
  LOGIN_MAX_FAILED_PER_ACCOUNT: '1000',
});

const prisma = new PrismaClient();
const pool = createSessionPool(env);
const fx = new Fixtures(prisma);
const tickets = new TicketService(prisma);
let app: express.Express;

const API = '/admin/api/resources';
const csrfFrom = (html: string) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';

/** A signed-in session: GET helpers plus POST helpers that carry Origin and the CSRF header. */
async function signIn(email: string) {
  const agent = request.agent(app);
  const page = await agent.get('/auth/login');
  const res = await agent.post('/auth/login').set('Origin', ORIGIN).type('form').send({ _csrf: csrfFrom(page.text), email, password: TEST_PASSWORD });
  expect(res.status).toBe(303);
  const { token } = (await agent.get('/auth/csrf')).body as { token: string };
  return {
    get: (url: string) => agent.get(url),
    post: (url: string, body: object = {}) => agent.post(url).set('Origin', ORIGIN).set('X-CSRF-Token', token).send(body),
  };
}
type Session = Awaited<ReturnType<typeof signIn>>;

/** AdminJS reports refusals as HTTP 200 with a typed base error; the data must also stay untouched. */
const refusal = (res: request.Response): string | undefined => res.body?.record?.baseError?.type ?? res.body?.notice?.type;
const ids = (res: request.Response): string[] => (res.body.records as { id: string }[]).map((r) => r.id);
const list = (s: Session, resource: string, query = '') => s.get(`${API}/${resource}/actions/list?${query}`);

// Two groups, each with an agent; tickets in both.
let groupA: Awaited<ReturnType<Fixtures['group']>>;
let groupB: Awaited<ReturnType<Fixtures['group']>>;
let admin: Awaited<ReturnType<Fixtures['admin']>>;
let agentA: Awaited<ReturnType<Fixtures['agent']>>;
let agentA2: Awaited<ReturnType<Fixtures['agent']>>;
let agentB: Awaited<ReturnType<Fixtures['agent']>>;
let customer: Awaited<ReturnType<Fixtures['customer']>>;
let ticketA: { id: string; version: number };
let ticketB: { id: string; version: number };
let ticketA2: { id: string; version: number };

beforeAll(async () => {
  await fx.init();
  app = await buildApp({ env, prisma, sessionPool: pool });
  groupA = await fx.group();
  groupB = await fx.group();
  admin = await fx.admin();
  agentA = await fx.agent([groupA]);
  agentA2 = await fx.agent([groupA]);
  agentB = await fx.agent([groupB]);
  customer = await fx.customer();
  const base = { description: 'Details', customerId: customer.id };
  ticketA = await tickets.create(admin.actor, { ...base, subject: 'Printer Offline in room A', groupId: groupA.id, priority: 'HIGH', assignedAgentId: agentA.agent.id });
  ticketA2 = await tickets.create(admin.actor, { ...base, subject: 'Password reset request', groupId: groupA.id });
  ticketB = await tickets.create(admin.actor, { ...base, subject: 'Invoice mismatch', groupId: groupB.id });
});

afterAll(async () => {
  await pool.query(`DELETE FROM support."Session" WHERE sess->>'userId' = ANY($1::text[])`, [
    [admin.user.id, agentA.user.id, agentA2.user.id, agentB.user.id],
  ]);
  await fx.cleanup();
  await prisma.$disconnect();
  await pool.end();
});

describe('ticket list scope', () => {
  it('shows ADMIN every group and an AGENT only their own', async () => {
    const adminSession = await signIn(admin.user.normalizedEmail);
    const all = ids(await list(adminSession, 'Ticket', `filters.customer=${customer.id}`));
    expect(all).toEqual(expect.arrayContaining([ticketA.id, ticketA2.id, ticketB.id]));

    const a = await signIn(agentA.user.normalizedEmail);
    const own = await list(a, 'Ticket', `filters.customer=${customer.id}`);
    expect(ids(own).sort()).toEqual([ticketA.id, ticketA2.id].sort());
    expect(own.body.meta.total).toBe(2);
  });

  it('cannot be widened by a user filter, and the total does not count hidden tickets', async () => {
    const a = await signIn(agentA.user.normalizedEmail);
    const foreign = await list(a, 'Ticket', `filters.group=${groupB.id}`);
    expect(foreign.body.records).toHaveLength(0);
    expect(foreign.body.meta.total).toBe(0);
  });

  it('hides tickets of other groups on show, edit and search as 404', async () => {
    const a = await signIn(agentA.user.normalizedEmail);
    for (const view of ['show', 'edit']) {
      const hidden = await a.get(`${API}/Ticket/records/${ticketB.id}/${view}`);
      expect(refusal(hidden), view).toBe('NotFoundError');
      expect(hidden.body.record.params, view).toEqual({});
    }
    const own = await a.get(`${API}/Ticket/records/${ticketA.id}/show`);
    expect(own.body.record.params.subject).toContain('Printer');
    const search = await a.get(`${API}/Ticket/actions/search/Invoice`);
    expect(search.body.records).toHaveLength(0);
  });

  it('gives an AGENT with no group an empty list', async () => {
    const loner = await fx.agent([]);
    const s = await signIn(loner.user.normalizedEmail);
    expect((await list(s, 'Ticket')).body.records).toHaveLength(0);
  });
});

describe('ticket filters, sorting and paging', () => {
  it('searches the subject case-insensitively and by number', async () => {
    const s = await signIn(admin.user.normalizedEmail);
    expect(ids(await list(s, 'Ticket', 'filters.subject=printer OFFLINE'))).toContain(ticketA.id);
    const row = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketB.id } });
    expect(ids(await list(s, 'Ticket', `filters.number=${row.number}`))).toEqual([ticketB.id]);
  });

  it('filters by priority, group and unassigned', async () => {
    const s = await signIn(admin.user.normalizedEmail);
    const high = ids(await list(s, 'Ticket', `filters.priority=HIGH&filters.customer=${customer.id}`));
    expect(high).toEqual([ticketA.id]);
    const unassigned = ids(await list(s, 'Ticket', `filters.assignedAgent=__none__&filters.group=${groupA.id}`));
    expect(unassigned).toEqual([ticketA2.id]);
  });

  it('filters by status and by date range', async () => {
    const s = await signIn(admin.user.normalizedEmail);
    const status = await prisma.ticketStatus.findUniqueOrThrow({ where: { code: 'NEW' } });
    expect(ids(await list(s, 'Ticket', `filters.status=${status.id}&filters.customer=${customer.id}`))).toHaveLength(3);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect((await list(s, 'Ticket', `filters.updatedAt~~from=${future}&filters.customer=${customer.id}`)).body.records).toHaveLength(0);
    const past = new Date(Date.now() - 86_400_000).toISOString();
    expect((await list(s, 'Ticket', `filters.updatedAt~~from=${past}&filters.customer=${customer.id}`)).body.records).toHaveLength(3);
  });

  it('treats malformed filter values as "no match", not as a server error', async () => {
    const s = await signIn(admin.user.normalizedEmail);
    for (const q of ['filters.group=not-a-uuid', 'filters.number=abc', 'filters.priority=BOGUS', 'filters.customer=%27%3B--']) {
      const res = await list(s, 'Ticket', q);
      expect(res.status, q).toBe(200);
      expect(res.body.records, q).toHaveLength(0);
    }
  });

  it('sorts by most recently updated first', async () => {
    const s = await signIn(admin.user.normalizedEmail);
    const fresh = await tickets.create(admin.actor, { subject: 'Newest ticket', description: 'd', customerId: customer.id, groupId: groupB.id });
    const res = await list(s, 'Ticket', `filters.customer=${customer.id}`);
    expect(ids(res)[0]).toBe(fresh.id);
    const touched = await tickets.update(admin.actor, ticketB.id, ticketB.version, { priority: 'LOW' });
    ticketB.version = touched.version;
    expect(ids(await list(s, 'Ticket', `filters.customer=${customer.id}`))[0]).toBe(ticketB.id);
  });

  it('never returns more than 100 rows per page', async () => {
    const group = await fx.group();
    const cust = await fx.customer();
    const status = await prisma.ticketStatus.findUniqueOrThrow({ where: { code: 'NEW' } });
    await prisma.ticket.createMany({
      data: Array.from({ length: 105 }, (_, i) => ({
        subject: `Bulk ticket ${i}`,
        description: 'd',
        customerId: cust.id,
        groupId: group.id,
        statusId: status.id,
        createdByUserId: admin.user.id,
      })),
    });
    const s = await signIn(admin.user.normalizedEmail);
    const page = await list(s, 'Ticket', `filters.group=${group.id}&perPage=500`);
    expect(page.body.records).toHaveLength(100);
    expect(page.body.meta.total).toBe(105);
    const second = await list(s, 'Ticket', `filters.group=${group.id}&perPage=100&page=2`);
    expect(second.body.records).toHaveLength(5);
    expect(new Set([...ids(page), ...ids(second)]).size).toBe(105); // stable, non-overlapping pages
  });
});

describe('ticket writes go through the service', () => {
  it('creates a NEW ticket with history, and rejects a group the agent does not belong to', async () => {
    const a = await signIn(agentA.user.normalizedEmail);
    const ok = await a.post(`${API}/Ticket/actions/new`, { subject: 'Created via admin', description: 'Body', customer: customer.id, group: groupA.id, priority: 'URGENT' });
    expect(ok.status).toBe(200);
    expect(ok.body.record.errors).toEqual({});
    const created = await prisma.ticket.findFirstOrThrow({ where: { subject: 'Created via admin' }, include: { status: true } });
    expect(created.status.code).toBe('NEW');
    expect(created.createdByUserId).toBe(agentA.user.id);
    expect(await prisma.ticketHistory.count({ where: { ticketId: created.id, kind: 'CREATED' } })).toBe(1);

    const denied = await a.post(`${API}/Ticket/actions/new`, { subject: 'Sneaky ticket', description: 'Body', customer: customer.id, group: groupB.id });
    expect(denied.status).toBe(403);
    expect(await prisma.ticket.count({ where: { subject: 'Sneaky ticket' } })).toBe(0);
  });

  it('shows validation errors next to the fields', async () => {
    const a = await signIn(agentA.user.normalizedEmail);
    const bad = await a.post(`${API}/Ticket/actions/new`, { subject: 'abc', description: '', customer: customer.id, group: groupA.id });
    expect(bad.status).toBe(200);
    expect(Object.keys(bad.body.record.errors)).toEqual(expect.arrayContaining(['subject', 'description']));
  });

  it('edits allowed fields, bumps the version and reports a stale version as a form error', async () => {
    const a = await signIn(agentA.user.normalizedEmail);
    const shown = await a.get(`${API}/Ticket/records/${ticketA.id}/show`);
    const params = shown.body.record.params as Record<string, unknown>;
    const ok = await a.post(`${API}/Ticket/records/${ticketA.id}/edit`, { ...params, subject: 'Printer offline, room A (updated)' });
    expect(ok.status).toBe(200);
    expect(ok.body.record.errors).toEqual({});
    const after = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketA.id } });
    expect(after.subject).toBe('Printer offline, room A (updated)');
    expect(after.version).toBe(ticketA.version + 1);

    const stale = await a.post(`${API}/Ticket/records/${ticketA.id}/edit`, { ...params, subject: 'Stale overwrite attempt' });
    expect(stale.body.notice.type).toBe('error');
    expect(Object.keys(stale.body.record.errors)).toContain('version'); // otherwise AdminJS would report success
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticketA.id } })).subject).toBe('Printer offline, room A (updated)');
    ticketA.version = after.version;
  });

  it('rejects an edit that tries to change group, assignee, status or customer', async () => {
    const a = await signIn(agentA.user.normalizedEmail);
    const params = (await a.get(`${API}/Ticket/records/${ticketA.id}/show`)).body.record.params as Record<string, unknown>;
    const done = await prisma.ticketStatus.findUniqueOrThrow({ where: { code: 'CLOSED' } });
    const res = await a.post(`${API}/Ticket/records/${ticketA.id}/edit`, {
      ...params,
      group: groupB.id,
      assignedAgent: agentA2.agent.id,
      status: done.id,
    });
    expect(Object.keys(res.body.record.errors)).toEqual(expect.arrayContaining(['group', 'assignedAgent', 'status']));
    const after = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketA.id } });
    expect(after.groupId).toBe(groupA.id);
    expect(after.assignedAgentId).toBe(agentA.agent.id);
    expect(after.statusId).not.toBe(done.id);
  });

  it('refuses to edit a ticket outside the agent scope', async () => {
    const a = await signIn(agentA.user.normalizedEmail);
    const res = await a.post(`${API}/Ticket/records/${ticketB.id}/edit`, { subject: 'Hijacked subject' });
    expect(refusal(res)).toBe('NotFoundError');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticketB.id } })).subject).not.toBe('Hijacked subject');
  });

  it('offers no way to delete tickets', async () => {
    const s = await signIn(admin.user.normalizedEmail);
    expect(refusal(await s.post(`${API}/Ticket/records/${ticketA2.id}/delete`))).toBe('ForbiddenError');
    expect(refusal(await s.post(`${API}/Ticket/bulk/bulkDelete?recordIds=${ticketA2.id}`))).toBe('ForbiddenError');
    expect(await prisma.ticket.count({ where: { id: ticketA2.id } })).toBe(1);
  });
});

describe('customers', () => {
  it('lets any staff member create a customer and search by name, email and company', async () => {
    const a = await signIn(agentA.user.normalizedEmail);
    const email = `new-customer-${Date.now()}@example.test`;
    const created = await a.post(`${API}/Customer/actions/new`, { name: 'Zed Тестовый', emailNormalized: ` ${email.toUpperCase()} `, company: 'Acme', phone: '' });
    expect(created.body.record.errors).toEqual({});
    const row = await prisma.customer.findUniqueOrThrow({ where: { emailNormalized: email } });
    expect(row.phone).toBeNull();
    expect(row.isActive).toBe(true);
    fxCustomerIds.push(row.id);

    expect(ids(await list(a, 'Customer', 'filters.name=тестовый'))).toContain(row.id); // Cyrillic, case-insensitive
    expect(ids(await list(a, 'Customer', `filters.emailNormalized=${email.slice(0, 12)}`))).toContain(row.id);
    expect(ids(await list(a, 'Customer', 'filters.company=acme'))).toContain(row.id);
    expect(ids(await list(a, 'Customer', 'filters.isActive=false'))).not.toContain(row.id);
  });

  it('rejects a duplicate or malformed email with a field error', async () => {
    const a = await signIn(agentA.user.normalizedEmail);
    const dup = await a.post(`${API}/Customer/actions/new`, { name: 'Dup', emailNormalized: customer.emailNormalized.toUpperCase() });
    expect(Object.keys(dup.body.record.errors)).toContain('emailNormalized');
    const bad = await a.post(`${API}/Customer/actions/new`, { name: 'Bad', emailNormalized: 'not-an-email' });
    expect(Object.keys(bad.body.record.errors)).toContain('emailNormalized');
  });

  it('lets only ADMIN edit or deactivate', async () => {
    const a = await signIn(agentA.user.normalizedEmail);
    const denied = await a.post(`${API}/Customer/records/${customer.id}/edit`, { name: 'Renamed by agent' });
    expect(refusal(denied)).toBe('ForbiddenError');
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).name).toBe(customer.name);

    const s = await signIn(admin.user.normalizedEmail);
    const params = (await s.get(`${API}/Customer/records/${customer.id}/show`)).body.record.params as Record<string, unknown>;
    const ok = await s.post(`${API}/Customer/records/${customer.id}/edit`, { ...params, company: 'Edited Inc', isActive: true });
    expect(ok.body.record.errors).toEqual({});
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).company).toBe('Edited Inc');
  });

  it('keeps inactive customers out of new tickets', async () => {
    const inactive = await fx.customer({ active: false });
    const a = await signIn(agentA.user.normalizedEmail);
    const res = await a.post(`${API}/Ticket/actions/new`, { subject: 'For inactive customer', description: 'd', customer: inactive.id, group: groupA.id });
    expect(Object.keys(res.body.record.errors)).toContain('customer');
  });
});

describe('reference data', () => {
  it('limits group and agent lookups for an AGENT to their own groups', async () => {
    const a = await signIn(agentA.user.normalizedEmail);
    const groups = ids(await a.get(`${API}/SupportGroup/actions/list`));
    expect(groups).toContain(groupA.id);
    expect(groups).not.toContain(groupB.id);
    const agentIds = ids(await a.get(`${API}/Agent/actions/list`));
    expect(agentIds).toEqual(expect.arrayContaining([agentA.agent.id, agentA2.agent.id]));
    expect(agentIds).not.toContain(agentB.agent.id);
  });

  it('never returns password hashes, and shows staff accounts to ADMIN only', async () => {
    const s = await signIn(admin.user.normalizedEmail);
    const users = await s.get(`${API}/User/actions/list?perPage=100`);
    expect(users.status).toBe(200);
    expect(JSON.stringify(users.body)).not.toContain('passwordHash');
    expect(JSON.stringify(users.body)).not.toContain('not-a-real-hash');

    const a = await signIn(agentA.user.normalizedEmail);
    expect(refusal(await a.get(`${API}/User/actions/list`))).toBe('ForbiddenError');
    const shown = await a.get(`${API}/Ticket/records/${ticketA.id}/show`);
    // The creator's name is readable (needed to display the ticket) but nothing else about the account.
    const creator = shown.body.record.populated.createdBy.params as Record<string, unknown>;
    expect(creator.displayName).toBe(admin.user.displayName);
    for (const secret of ['normalizedEmail', 'role', 'isActive', 'passwordHash', 'sessionVersion']) {
      expect(creator, secret).not.toHaveProperty(secret);
    }
  });

  it('exposes no write access to staff, groups, agents or statuses', async () => {
    const s = await signIn(admin.user.normalizedEmail);
    for (const resource of ['User', 'Agent', 'SupportGroup', 'TicketStatus']) {
      const res = await s.post(`${API}/${resource}/actions/new`, { displayName: 'x', name: 'x', code: 'X' });
      expect(refusal(res), resource).toBe('ForbiddenError');
    }
    expect(await prisma.supportGroup.count({ where: { code: 'X' } })).toBe(0);
  });
});

const fxCustomerIds: string[] = [];
afterAll(async () => {
  await prisma.customer.deleteMany({ where: { id: { in: fxCustomerIds } } });
});
