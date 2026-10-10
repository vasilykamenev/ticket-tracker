import { PrismaClient } from '@prisma/client';
import type express from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TicketService } from '../../src/domain/tickets/ticket-service.js';
import { Fixtures, TEST_PASSWORD } from './helpers/fixtures.js';
import { API, ORIGIN, createTestApp, signIn } from './helpers/http.js';

const prisma = new PrismaClient();
const fx = new Fixtures(prisma);
const tickets = new TicketService(prisma);
let app: express.Express;
let pool: Pool;
let admin: Awaited<ReturnType<Fixtures['admin']>>;
let agent: Awaited<ReturnType<Fixtures['agent']>>;
let group: Awaited<ReturnType<Fixtures['group']>>;

const NEW_PASSWORD = 'A-brand-new-passphrase';

/** AdminJS reports refusals as HTTP 200 with a typed base error. */
const refusal = (res: { body: { record?: { baseError?: { type?: string } } } }) => res.body.record?.baseError?.type;
const errorFields = (res: { body: { record: { errors: object } } }) => Object.keys(res.body.record.errors);

const sessionUserIds: string[] = [];

beforeAll(async () => {
  await fx.init();
  ({ app, pool } = await createTestApp(prisma));
  group = await fx.group();
  admin = await fx.admin();
  agent = await fx.agent([group]);
  sessionUserIds.push(admin.user.id, agent.user.id);
});

afterAll(async () => {
  await pool.query(`DELETE FROM support."Session" WHERE sess->>'userId' = ANY($1::text[])`, [sessionUserIds]);
  await fx.cleanup();
  await prisma.$disconnect();
  await pool.end();
});

/** Creates an account through the admin API and tracks it for cleanup. */
async function createViaApi(role: 'ADMIN' | 'AGENT' = 'AGENT') {
  const s = await signIn(app, admin.user.normalizedEmail);
  const email = fx.email('api-user');
  const res = await s.post(`${API}/User/actions/new`, { normalizedEmail: email, displayName: 'Api User', role, password: NEW_PASSWORD });
  const user = await prisma.user.findUniqueOrThrow({ where: { normalizedEmail: email } });
  fx.trackUser(user.id);
  sessionUserIds.push(user.id);
  return { res, user, email };
}

describe('staff accounts', () => {
  it('creates an account that can sign in, without ever echoing the password hash', async () => {
    const { res, user, email } = await createViaApi('AGENT');
    expect(res.body.record.errors).toEqual({});
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$argon2/);
    expect(await prisma.agent.findUnique({ where: { userId: user.id } })).toMatchObject({ isActive: true });

    const anonymous = request.agent(app);
    const page = await anonymous.get('/auth/login');
    const token = /name="_csrf" value="([^"]+)"/.exec(page.text)![1];
    const login = await anonymous.post('/auth/login').set('Origin', ORIGIN).type('form').send({ _csrf: token, email, password: NEW_PASSWORD });
    expect(login.status).toBe(303);
  }, 20_000);

  it('shows field errors for a weak password and a duplicate email', async () => {
    const s = await signIn(app, admin.user.normalizedEmail);
    const weak = await s.post(`${API}/User/actions/new`, { normalizedEmail: fx.email('weak'), displayName: 'Weak', role: 'AGENT', password: 'short' });
    expect(errorFields(weak)).toContain('password');
    const dup = await s.post(`${API}/User/actions/new`, { normalizedEmail: agent.user.normalizedEmail.toUpperCase(), displayName: 'Dup', role: 'AGENT', password: NEW_PASSWORD });
    expect(errorFields(dup)).toContain('normalizedEmail');
  });

  it('is closed to AGENTs: no list, no create, no edit', async () => {
    const a = await signIn(app, agent.user.normalizedEmail);
    expect(refusal(await a.get(`${API}/User/actions/list`))).toBe('ForbiddenError');
    expect(refusal(await a.post(`${API}/User/actions/new`, { normalizedEmail: fx.email('x'), displayName: 'X', role: 'ADMIN', password: NEW_PASSWORD }))).toBe('ForbiddenError');
    // Someone else's account cannot even be loaded by an AGENT; their own account can, but not edited.
    expect(refusal(await a.post(`${API}/User/records/${admin.user.id}/edit`, { displayName: 'Hijack' }))).toBe('NotFoundError');
    expect(refusal(await a.post(`${API}/User/records/${agent.user.id}/edit`, { displayName: 'Self edit' }))).toBe('ForbiddenError');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.user.id } })).displayName).toBe(admin.user.displayName);
  });

  it('keeps role and password out of the profile form', async () => {
    const { user } = await createViaApi('AGENT');
    const s = await signIn(app, admin.user.normalizedEmail);
    const params = (await s.get(`${API}/User/records/${user.id}/show`)).body.record.params as Record<string, unknown>;
    expect(params).not.toHaveProperty('passwordHash');

    const promote = await s.post(`${API}/User/records/${user.id}/edit`, { ...params, role: 'ADMIN' });
    expect(errorFields(promote)).toContain('role');
    const sneaky = await s.post(`${API}/User/records/${user.id}/edit`, { ...params, password: NEW_PASSWORD });
    expect(errorFields(sneaky)).toContain('password');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).role).toBe('AGENT');

    const ok = await s.post(`${API}/User/records/${user.id}/edit`, { ...params, displayName: 'Renamed Via Form' });
    expect(ok.body.record.errors).toEqual({});
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).displayName).toBe('Renamed Via Form');
  });
});

describe('signing people out', () => {
  async function signedInAs(user: { normalizedEmail: string }) {
    // The fixture accounts use TEST_PASSWORD; accounts created through the API get it set explicitly here.
    return signIn(app, user.normalizedEmail);
  }

  it('deactivating an account ends its session on the next request', async () => {
    const victim = await fx.agent([group]);
    sessionUserIds.push(victim.user.id);
    const v = await signedInAs(victim.user);
    expect((await v.get(`${API}/Customer/actions/list`)).status).toBe(200);

    const s = await signIn(app, admin.user.normalizedEmail);
    const params = (await s.get(`${API}/User/records/${victim.user.id}/show`)).body.record.params as Record<string, unknown>;
    const off = await s.post(`${API}/User/records/${victim.user.id}/edit`, { ...params, isActive: false });
    expect(off.body.record.errors).toEqual({});
    expect((await v.get(`${API}/Customer/actions/list`)).status).toBe(401);
  });

  it('setPassword replaces the password, signs the user out and refuses short ones', async () => {
    const target = await fx.agent([group]);
    sessionUserIds.push(target.user.id);
    const t = await signedInAs(target.user);
    const s = await signIn(app, admin.user.normalizedEmail);

    const short = await s.post(`${API}/User/records/${target.user.id}/setPassword`, { password: 'short' });
    expect(short.status).toBe(422);
    expect((await t.get(`${API}/Customer/actions/list`)).status).toBe(200); // untouched by the failed attempt

    const ok = await s.post(`${API}/User/records/${target.user.id}/setPassword`, { password: NEW_PASSWORD });
    expect(ok.status).toBe(200);
    expect(JSON.stringify(ok.body)).not.toMatch(/passwordHash|\$argon2/);
    expect((await t.get(`${API}/Customer/actions/list`)).status).toBe(401);

    const anonymous = request.agent(app);
    const page = await anonymous.get('/auth/login');
    const token = /name="_csrf" value="([^"]+)"/.exec(page.text)![1];
    const login = (password: string) => anonymous.post('/auth/login').set('Origin', ORIGIN).type('form').send({ _csrf: token, email: target.user.normalizedEmail, password });
    expect((await login(TEST_PASSWORD)).status).toBe(401);
    expect((await login(NEW_PASSWORD)).status).toBe(303);
  }, 20_000);

  it('changeRole promotes, signs the user out, and cannot be used on yourself or by an AGENT', async () => {
    const target = await fx.agent([group]);
    sessionUserIds.push(target.user.id);
    const t = await signedInAs(target.user);
    const s = await signIn(app, admin.user.normalizedEmail);

    const self = await s.post(`${API}/User/records/${admin.user.id}/changeRole`, { role: 'AGENT' });
    expect(self.status).toBe(403);
    expect(self.body.error).toBe('self_change');

    const ok = await s.post(`${API}/User/records/${target.user.id}/changeRole`, { role: 'ADMIN' });
    expect(ok.status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.user.id } })).role).toBe('ADMIN');
    expect((await t.get(`${API}/Customer/actions/list`)).status).toBe(401);

    const a = await signIn(app, agent.user.normalizedEmail);
    expect(refusal(await a.post(`${API}/User/records/${agent.user.id}/changeRole`, { role: 'ADMIN' }))).toBe('ForbiddenError');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: agent.user.id } })).role).toBe('AGENT');
  });
});

describe('groups and members', () => {
  it('creates and edits a group, but not its code', async () => {
    const s = await signIn(app, admin.user.normalizedEmail);
    const code = `API_${Date.now()}`;
    const created = await s.post(`${API}/SupportGroup/actions/new`, { code, name: 'Created Via Api', description: 'First' });
    expect(created.body.record.errors).toEqual({});
    const row = await prisma.supportGroup.findUniqueOrThrow({ where: { code } });
    fx.trackGroup(row.id);

    const params = (await s.get(`${API}/SupportGroup/records/${row.id}/show`)).body.record.params as Record<string, unknown>;
    const ok = await s.post(`${API}/SupportGroup/records/${row.id}/edit`, { ...params, name: 'Renamed Group' });
    expect(ok.body.record.errors).toEqual({});
    const tamper = await s.post(`${API}/SupportGroup/records/${row.id}/edit`, { ...params, code: 'CHANGED' });
    expect(errorFields(tamper)).toContain('code');
    expect(await prisma.supportGroup.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ code, name: 'Renamed Group' });

    const bad = await s.post(`${API}/SupportGroup/actions/new`, { code: 'lower case', name: 'Bad' });
    expect(errorFields(bad)).toContain('code');
  });

  it('lets ADMIN manage members, and AGENTs only read their own group\'s list', async () => {
    const solo = await fx.group();
    const joiner = await fx.agent([]);
    const s = await signIn(app, admin.user.normalizedEmail);

    const before = await s.get(`${API}/SupportGroup/records/${solo.id}/members`);
    expect(before.body).toMatchObject({ canEdit: true, groupActive: true });
    expect(before.body.candidates.map((c: { id: string }) => c.id)).toContain(joiner.agent.id);

    expect((await s.post(`${API}/SupportGroup/records/${solo.id}/addMember`, { agentId: joiner.agent.id })).status).toBe(200);
    expect(await prisma.agentGroup.count({ where: { agentId: joiner.agent.id, groupId: solo.id } })).toBe(1);
    const dup = await s.post(`${API}/SupportGroup/records/${solo.id}/addMember`, { agentId: joiner.agent.id });
    expect(dup.status).toBe(422);

    const viewer = await signIn(app, agent.user.normalizedEmail);
    const own = await viewer.get(`${API}/SupportGroup/records/${group.id}/members`);
    expect(own.body).toMatchObject({ canEdit: false, candidates: [] });
    expect(own.body.members.map((m: { agentId: string }) => m.agentId)).toContain(agent.agent.id);
    expect(refusal(await viewer.get(`${API}/SupportGroup/records/${solo.id}/members`))).toBe('NotFoundError'); // not their group
    expect(refusal(await viewer.post(`${API}/SupportGroup/records/${group.id}/addMember`, { agentId: agent.agent.id }))).toBe('ForbiddenError');

    expect((await s.post(`${API}/SupportGroup/records/${solo.id}/removeMember`, { agentId: joiner.agent.id })).status).toBe(200);
    expect(await prisma.agentGroup.count({ where: { agentId: joiner.agent.id, groupId: solo.id } })).toBe(0);
  });

  it('refuses to remove a member who holds active tickets and explains why', async () => {
    const g = await fx.group();
    const customer = await fx.customer();
    const worker = await fx.agent([g]);
    await tickets.create(admin.actor, { subject: 'Held ticket', description: 'd', customerId: customer.id, groupId: g.id, assignedAgentId: worker.agent.id });
    const s = await signIn(app, admin.user.normalizedEmail);
    const res = await s.post(`${API}/SupportGroup/records/${g.id}/removeMember`, { agentId: worker.agent.id });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('has_active_tickets');
    expect(await prisma.agentGroup.count({ where: { agentId: worker.agent.id, groupId: g.id } })).toBe(1);
  });
});

describe('agents and statuses', () => {
  it('creates a support profile for an administrator account, and rejects a second one', async () => {
    const { user } = await createViaApi('ADMIN');
    const s = await signIn(app, admin.user.normalizedEmail);
    const ok = await s.post(`${API}/Agent/actions/new`, { user: user.id, displayName: 'Admin As Agent' });
    expect(ok.body.record.errors).toEqual({});
    expect(await prisma.agent.findUnique({ where: { userId: user.id } })).toMatchObject({ displayName: 'Admin As Agent', isActive: true });
    const again = await s.post(`${API}/Agent/actions/new`, { user: user.id });
    expect(errorFields(again)).toContain('user');
  });

  it('shows why an agent with active tickets cannot be deactivated', async () => {
    const g = await fx.group();
    const customer = await fx.customer();
    const worker = await fx.agent([g]);
    await tickets.create(admin.actor, { subject: 'Agent is busy', description: 'd', customerId: customer.id, groupId: g.id, assignedAgentId: worker.agent.id });
    const s = await signIn(app, admin.user.normalizedEmail);
    const params = (await s.get(`${API}/Agent/records/${worker.agent.id}/show`)).body.record.params as Record<string, unknown>;
    const res = await s.post(`${API}/Agent/records/${worker.agent.id}/edit`, { ...params, isActive: false });
    expect(res.body.notice.type).toBe('error');
    expect(Object.keys(res.body.record.errors).length).toBeGreaterThan(0);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: worker.agent.id } })).isActive).toBe(true);
  });

  it('edits status presentation, never its code, and offers no way to add statuses', async () => {
    const status = await prisma.ticketStatus.create({ data: { code: `API_${Date.now()}`, name: 'Api status', color: '#112233', sortOrder: 900 } });
    try {
      const s = await signIn(app, admin.user.normalizedEmail);
      const params = (await s.get(`${API}/TicketStatus/records/${status.id}/show`)).body.record.params as Record<string, unknown>;
      const ok = await s.post(`${API}/TicketStatus/records/${status.id}/edit`, { ...params, name: 'Renamed status', color: '#abcdef', sortOrder: 901 });
      expect(ok.body.record.errors).toEqual({});
      expect(await prisma.ticketStatus.findUniqueOrThrow({ where: { id: status.id } })).toMatchObject({ name: 'Renamed status', color: '#abcdef', sortOrder: 901 });

      expect(errorFields(await s.post(`${API}/TicketStatus/records/${status.id}/edit`, { ...params, code: 'HACKED' }))).toContain('code');
      expect(errorFields(await s.post(`${API}/TicketStatus/records/${status.id}/edit`, { ...params, color: 'red' }))).toContain('color');
      expect(refusal(await s.post(`${API}/TicketStatus/actions/new`, { code: 'NEWONE', name: 'New one' }))).toBe('ForbiddenError');

      const a = await signIn(app, agent.user.normalizedEmail);
      expect(refusal(await a.post(`${API}/TicketStatus/records/${status.id}/edit`, { ...params, name: 'Hijack' }))).toBe('ForbiddenError');
      const agentList = await a.get(`${API}/TicketStatus/actions/list?perPage=100`);
      expect((agentList.body.records as { params: { code: string } }[]).every((r) => r.params.code !== undefined)).toBe(true);
    } finally {
      await prisma.ticketStatus.delete({ where: { id: status.id } });
    }
  });
});
