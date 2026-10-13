import { PrismaClient } from '@prisma/client';
import type express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TicketService } from '../../src/domain/tickets/ticket-service.js';
import type { Pool } from 'pg';
import { Fixtures } from './helpers/fixtures.js';
import { API, createTestApp, signIn, type Session } from './helpers/http.js';

const prisma = new PrismaClient();
const fx = new Fixtures(prisma);
const tickets = new TicketService(prisma);
let app: express.Express;
let pool: Pool;

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
  ({ app, pool } = await createTestApp(prisma));
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
    const adminSession = await signIn(app, admin.user.normalizedEmail);
    const all = ids(await list(adminSession, 'Ticket', `filters.customer=${customer.id}`));
    expect(all).toEqual(expect.arrayContaining([ticketA.id, ticketA2.id, ticketB.id]));

    const a = await signIn(app, agentA.user.normalizedEmail);
    const own = await list(a, 'Ticket', `filters.customer=${customer.id}`);
    expect(ids(own).sort()).toEqual([ticketA.id, ticketA2.id].sort());
    expect(own.body.meta.total).toBe(2);
  });

  it('cannot be widened by a user filter, and the total does not count hidden tickets', async () => {
    const a = await signIn(app, agentA.user.normalizedEmail);
    const foreign = await list(a, 'Ticket', `filters.group=${groupB.id}`);
    expect(foreign.body.records).toHaveLength(0);
    expect(foreign.body.meta.total).toBe(0);
  });

  it('hides tickets of other groups on show, edit and search as 404', async () => {
    const a = await signIn(app, agentA.user.normalizedEmail);
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
    const s = await signIn(app, loner.user.normalizedEmail);
    expect((await list(s, 'Ticket')).body.records).toHaveLength(0);
  });
});

describe('ticket filters, sorting and paging', () => {
  it('searches the subject case-insensitively and by number', async () => {
    const s = await signIn(app, admin.user.normalizedEmail);
    expect(ids(await list(s, 'Ticket', 'filters.subject=printer OFFLINE'))).toContain(ticketA.id);
    const row = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketB.id } });
    expect(ids(await list(s, 'Ticket', `filters.number=${row.number}`))).toEqual([ticketB.id]);
  });

  it('filters by priority, group and unassigned', async () => {
    const s = await signIn(app, admin.user.normalizedEmail);
    const high = ids(await list(s, 'Ticket', `filters.priority=HIGH&filters.customer=${customer.id}`));
    expect(high).toEqual([ticketA.id]);
    const unassigned = ids(await list(s, 'Ticket', `filters.assignedAgent=__none__&filters.group=${groupA.id}`));
    expect(unassigned).toEqual([ticketA2.id]);
  });

  it('filters by status and by date range', async () => {
    const s = await signIn(app, admin.user.normalizedEmail);
    const status = await prisma.ticketStatus.findUniqueOrThrow({ where: { code: 'NEW' } });
    expect(ids(await list(s, 'Ticket', `filters.status=${status.id}&filters.customer=${customer.id}`))).toHaveLength(3);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect((await list(s, 'Ticket', `filters.updatedAt~~from=${future}&filters.customer=${customer.id}`)).body.records).toHaveLength(0);
    const past = new Date(Date.now() - 86_400_000).toISOString();
    expect((await list(s, 'Ticket', `filters.updatedAt~~from=${past}&filters.customer=${customer.id}`)).body.records).toHaveLength(3);
  });

  it('lists "my open tickets": assigned to the agent and in any status but CLOSED', async () => {
    const closed = await tickets.create(admin.actor, { description: 'Done', customerId: customer.id, subject: 'Already closed for agent A', groupId: groupA.id, assignedAgentId: agentA.agent.id });
    const closedStatus = await prisma.ticketStatus.findUniqueOrThrow({ where: { code: 'CLOSED' } });
    await prisma.ticket.update({ where: { id: closed.id }, data: { statusId: closedStatus.id } });
    const coworker = await tickets.create(admin.actor, { description: 'Not mine', customerId: customer.id, subject: 'Assigned to a colleague', groupId: groupA.id, assignedAgentId: agentA2.agent.id });

    const a = await signIn(app, agentA.user.normalizedEmail);
    const mine = ids(await list(a, 'Ticket', `filters.assignedAgent=${agentA.agent.id}&filters.status=__open__`));
    expect(mine).toContain(ticketA.id);
    expect(mine).not.toContain(closed.id); // closed
    expect(mine).not.toContain(coworker.id); // somebody else's
    expect(mine).not.toContain(ticketA2.id); // unassigned

    // The same filter without the status part still shows the closed one, so the filter is what hides it.
    expect(ids(await list(a, 'Ticket', `filters.assignedAgent=${agentA.agent.id}`))).toContain(closed.id);
    // And it never reaches beyond the agent's own groups.
    const b = await signIn(app, agentB.user.normalizedEmail);
    expect(ids(await list(b, 'Ticket', `filters.assignedAgent=${agentA.agent.id}&filters.status=__open__`))).toEqual([]);
  });

  it('puts "My open tickets" in the menu for everyone who works in the panel', async () => {
    for (const email of [agentA.user.normalizedEmail, admin.user.normalizedEmail]) {
      const html = (await (await signIn(app, email)).get('/app')).text;
      expect(html).toMatch(/"name":"MyOpenTickets"/);
      expect(html).toContain('My open tickets');
    }
  });

  it('treats malformed filter values as "no match", not as a server error', async () => {
    const s = await signIn(app, admin.user.normalizedEmail);
    for (const q of ['filters.group=not-a-uuid', 'filters.number=abc', 'filters.priority=BOGUS', 'filters.customer=%27%3B--']) {
      const res = await list(s, 'Ticket', q);
      expect(res.status, q).toBe(200);
      expect(res.body.records, q).toHaveLength(0);
    }
  });

  it('sorts by most recently updated first', async () => {
    const s = await signIn(app, admin.user.normalizedEmail);
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
    const s = await signIn(app, admin.user.normalizedEmail);
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
    const a = await signIn(app, agentA.user.normalizedEmail);
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
    const a = await signIn(app, agentA.user.normalizedEmail);
    const bad = await a.post(`${API}/Ticket/actions/new`, { subject: 'abc', description: '', customer: customer.id, group: groupA.id });
    expect(bad.status).toBe(200);
    expect(Object.keys(bad.body.record.errors)).toEqual(expect.arrayContaining(['subject', 'description']));
  });

  it('edits allowed fields, bumps the version and reports a stale version as a form error', async () => {
    const a = await signIn(app, agentA.user.normalizedEmail);
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

  it('changes the status from the edit form, with the edits, and reports what the change lacks on the status field', async () => {
    const a = await signIn(app, agentA.user.normalizedEmail);
    const params = (await a.get(`${API}/Ticket/records/${ticketA.id}/show`)).body.record.params as Record<string, unknown>;
    const before = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketA.id }, include: { status: true } });
    expect(before.status.code).toBe('NEW'); // the fixture ticket has an assignee, so it can start work

    const ok = await a.post(`${API}/Ticket/records/${ticketA.id}/edit`, { ...params, priority: 'HIGH', statusTarget: 'IN_PROGRESS' });
    expect(ok.body.record.errors).toEqual({});
    const after = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketA.id }, include: { status: true } });
    expect(after.status.code).toBe('IN_PROGRESS');
    expect(after.priority).toBe('HIGH');

    const next = (await a.get(`${API}/Ticket/records/${ticketA.id}/show`)).body.record.params as Record<string, unknown>;
    const lacking = await a.post(`${API}/Ticket/records/${ticketA.id}/edit`, { ...next, priority: 'LOW', statusTarget: 'RESOLVED' });
    expect(lacking.body.record.errors.status.message).toContain('Resolution');
    const same = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketA.id } });
    expect(same.version).toBe(after.version); // the refused change took the edits with it
    expect(same.priority).toBe('HIGH');
    ticketA.version = after.version;
  });

  it('rejects an edit that tries to change group, assignee, status or customer', async () => {
    const a = await signIn(app, agentA.user.normalizedEmail);
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
    const a = await signIn(app, agentA.user.normalizedEmail);
    const res = await a.post(`${API}/Ticket/records/${ticketB.id}/edit`, { subject: 'Hijacked subject' });
    expect(refusal(res)).toBe('NotFoundError');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticketB.id } })).subject).not.toBe('Hijacked subject');
  });

  it('offers no way to delete tickets', async () => {
    const s = await signIn(app, admin.user.normalizedEmail);
    expect(refusal(await s.post(`${API}/Ticket/records/${ticketA2.id}/delete`))).toBe('ForbiddenError');
    expect(refusal(await s.post(`${API}/Ticket/bulk/bulkDelete?recordIds=${ticketA2.id}`))).toBe('ForbiddenError');
    expect(await prisma.ticket.count({ where: { id: ticketA2.id } })).toBe(1);
  });
});

describe('customers', () => {
  it('lets any staff member create a customer and search by name, email and company', async () => {
    const a = await signIn(app, agentA.user.normalizedEmail);
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
    const a = await signIn(app, agentA.user.normalizedEmail);
    const dup = await a.post(`${API}/Customer/actions/new`, { name: 'Dup', emailNormalized: customer.emailNormalized.toUpperCase() });
    expect(Object.keys(dup.body.record.errors)).toContain('emailNormalized');
    const bad = await a.post(`${API}/Customer/actions/new`, { name: 'Bad', emailNormalized: 'not-an-email' });
    expect(Object.keys(bad.body.record.errors)).toContain('emailNormalized');
  });

  it('lets only ADMIN edit or deactivate', async () => {
    const a = await signIn(app, agentA.user.normalizedEmail);
    const denied = await a.post(`${API}/Customer/records/${customer.id}/edit`, { name: 'Renamed by agent' });
    expect(refusal(denied)).toBe('ForbiddenError');
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).name).toBe(customer.name);

    const s = await signIn(app, admin.user.normalizedEmail);
    const params = (await s.get(`${API}/Customer/records/${customer.id}/show`)).body.record.params as Record<string, unknown>;
    const ok = await s.post(`${API}/Customer/records/${customer.id}/edit`, { ...params, company: 'Edited Inc', isActive: true });
    expect(ok.body.record.errors).toEqual({});
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).company).toBe('Edited Inc');
  });

  it('keeps inactive customers out of new tickets', async () => {
    const inactive = await fx.customer({ active: false });
    const a = await signIn(app, agentA.user.normalizedEmail);
    const res = await a.post(`${API}/Ticket/actions/new`, { subject: 'For inactive customer', description: 'd', customer: inactive.id, group: groupA.id });
    expect(Object.keys(res.body.record.errors)).toContain('customer');
  });
});

describe('reference data', () => {
  /** Which resources the page puts in the side menu: id -> link, as embedded in the page state. */
  const menu = (html: string) =>
    Object.fromEntries([...html.matchAll(/"id":"(\w+)","name":"\w+","navigation":(?:\{[^}]*\}|null),"href":(false|null|"[^"]*")/g)].map((m) => [m[1]!, m[2]!]));
  const administration = ['SupportGroup', 'Agent', 'TicketStatus', 'User'];

  it('shows the Administration pages in the menu to ADMIN only', async () => {
    const s = await signIn(app, admin.user.normalizedEmail);
    const forAdmin = menu((await s.get('/app')).text);
    for (const id of administration) expect(forAdmin[id], id).toMatch(/^"\/app\/resources\//);

    const a = await signIn(app, agentA.user.normalizedEmail);
    const forAgent = menu((await a.get('/app')).text);
    for (const id of administration) expect(forAgent[id] ?? 'none', id).not.toMatch(/^"\/app\/resources\//);
    // The support work itself stays in the menu.
    expect(forAgent.Ticket).toMatch(/^"\/app\/resources\//);
    expect(forAgent.Customer).toMatch(/^"\/app\/resources\//);
  });

  it('keeps the Administration lists and pages closed to an AGENT, while ADMIN opens them', async () => {
    const a = await signIn(app, agentA.user.normalizedEmail);
    for (const resource of administration) {
      expect(refusal(await a.get(`${API}/${resource}/actions/list`)), `${resource} list`).toBe('ForbiddenError');
    }
    expect(refusal(await a.get(`${API}/SupportGroup/records/${groupA.id}/show`))).toBe('ForbiddenError');
    expect(refusal(await a.get(`${API}/Agent/records/${agentA.agent.id}/show`))).toBe('ForbiddenError');

    const s = await signIn(app, admin.user.normalizedEmail);
    for (const resource of administration) expect((await s.get(`${API}/${resource}/actions/list`)).status, resource).toBe(200);
    expect(ids(await s.get(`${API}/SupportGroup/actions/list`))).toEqual(expect.arrayContaining([groupA.id, groupB.id]));
  });

  it('still offers an AGENT their own groups and colleagues in the ticket pickers (search), and nothing of other groups', async () => {
    const a = await signIn(app, agentA.user.normalizedEmail);
    const groups = ids(await a.get(`${API}/SupportGroup/actions/search/${encodeURIComponent(groupA.name)}`));
    expect(groups).toContain(groupA.id);
    expect(ids(await a.get(`${API}/SupportGroup/actions/search/${encodeURIComponent(groupB.name)}`))).not.toContain(groupB.id);
    const agentIds = ids(await a.get(`${API}/Agent/actions/search/${encodeURIComponent(agentA2.agent.displayName)}`));
    expect(agentIds).toContain(agentA2.agent.id);
    expect(ids(await a.get(`${API}/Agent/actions/search/${encodeURIComponent(agentB.agent.displayName)}`))).not.toContain(agentB.agent.id);
  });

  it('never returns password hashes, and shows staff accounts to ADMIN only', async () => {
    const s = await signIn(app, admin.user.normalizedEmail);
    const users = await s.get(`${API}/User/actions/list?perPage=100`);
    expect(users.status).toBe(200);
    expect(JSON.stringify(users.body)).not.toContain('passwordHash');
    expect(JSON.stringify(users.body)).not.toContain('not-a-real-hash');

    const a = await signIn(app, agentA.user.normalizedEmail);
    expect(refusal(await a.get(`${API}/User/actions/list`))).toBe('ForbiddenError');
    const shown = await a.get(`${API}/Ticket/records/${ticketA.id}/show`);
    // The creator's name is readable (needed to display the ticket) but nothing else about the account.
    const creator = shown.body.record.populated.createdBy.params as Record<string, unknown>;
    expect(creator.displayName).toBe(admin.user.displayName);
    for (const secret of ['normalizedEmail', 'role', 'isActive', 'passwordHash', 'sessionVersion']) {
      expect(creator, secret).not.toHaveProperty(secret);
    }
  });

  it('gives an AGENT no write access to staff, groups, agents or statuses, and nobody can add a status', async () => {
    const a = await signIn(app, agentA.user.normalizedEmail);
    for (const resource of ['User', 'Agent', 'SupportGroup', 'TicketStatus']) {
      const res = await a.post(`${API}/${resource}/actions/new`, { displayName: 'x', name: 'x', code: 'X' });
      expect(refusal(res), resource).toBe('ForbiddenError');
    }
    expect(await prisma.supportGroup.count({ where: { code: 'X' } })).toBe(0);

    const s = await signIn(app, admin.user.normalizedEmail);
    expect(refusal(await s.post(`${API}/TicketStatus/actions/new`, { code: 'X', name: 'x' }))).toBe('ForbiddenError'); // new codes need a migration
  });

});

const fxCustomerIds: string[] = [];
afterAll(async () => {
  await prisma.customer.deleteMany({ where: { id: { in: fxCustomerIds } } });
});
