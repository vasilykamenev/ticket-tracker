import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '../../src/domain/errors.js';
import { TicketQueries } from '../../src/domain/tickets/ticket-queries.js';
import { TicketService } from '../../src/domain/tickets/ticket-service.js';
import { Fixtures } from './helpers/fixtures.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for integration tests (see .env.example)');

const prisma = new PrismaClient();
const fx = new Fixtures(prisma);
const tickets = new TicketService(prisma);
const queries = new TicketQueries(prisma);

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
  const agentA = await fx.agent([groupA]);
  const colleague = await fx.agent([groupA]);
  const sleeping = await fx.agent([groupA], { active: false });
  const agentB = await fx.agent([groupB]);
  const base = { description: 'Details', customerId: customer.id };
  const ticket = await tickets.create(admin.actor, { ...base, subject: 'Printer offline', groupId: groupA.id });
  const foreign = await tickets.create(admin.actor, { ...base, subject: 'Invoice mismatch', groupId: groupB.id });
  return { groupA, groupB, customer, admin, agentA, colleague, sleeping, agentB, ticket, foreign, base };
}

describe('formState', () => {
  it('lists the transitions this actor may attempt, with the inputs each needs', async () => {
    const s = await scenario();
    const started = await tickets.changeStatus(
      s.admin.actor,
      (await tickets.assign(s.admin.actor, s.ticket.id, s.ticket.version, { assignedAgentId: s.agentA.agent.id })).id,
      2,
      { targetStatus: 'IN_PROGRESS' },
    );
    const asAdmin = await queries.formState(s.admin.actor, started.id);
    expect(asAdmin.ticket).toMatchObject({ statusCode: 'IN_PROGRESS', version: started.version, frozen: false, assigneeId: s.agentA.agent.id });
    expect(asAdmin.targets.map((t) => t.code).sort()).toEqual(['RESOLVED', 'UNRESOLVED', 'WAITING_CUSTOMER']);
    const resolved = asAdmin.targets.find((t) => t.code === 'RESOLVED')!;
    expect(resolved).toMatchObject({ resolution: true, unresolvedReason: false });
    expect(asAdmin.targets.find((t) => t.code === 'WAITING_CUSTOMER')!.reason).toBe('required');

    const done = await tickets.changeStatus(s.admin.actor, started.id, started.version, { targetStatus: 'RESOLVED', resolution: 'Restarted the sync job' });
    expect((await queries.formState(s.admin.actor, done.id)).targets.map((t) => t.code).sort()).toEqual(['CLOSED', 'IN_PROGRESS']);
    expect((await queries.formState(s.agentA.actor, done.id)).targets.map((t) => t.code)).toEqual(['IN_PROGRESS']); // CLOSED is ADMIN-only
  });

  it('offers only active members of the group, and an AGENT only their own groups', async () => {
    const s = await scenario();
    const asAgent = await queries.formState(s.agentA.actor, s.ticket.id);
    const agentIds = asAgent.agents.map((a) => a.id);
    expect(agentIds).toEqual(expect.arrayContaining([s.agentA.agent.id, s.colleague.agent.id]));
    expect(agentIds).not.toContain(s.sleeping.agent.id);
    expect(agentIds).not.toContain(s.agentB.agent.id);
    expect(asAgent.groups.map((g) => g.id)).toEqual([s.groupA.id]);

    const asAdmin = await queries.formState(s.admin.actor, s.ticket.id, s.groupB.id);
    expect(asAdmin.agents.map((a) => a.id)).toEqual([s.agentB.agent.id]);
    expect(asAdmin.groups.map((g) => g.id)).toEqual(expect.arrayContaining([s.groupA.id, s.groupB.id]));
  });

  it('refuses another group to an AGENT and hides out-of-scope tickets', async () => {
    const s = await scenario();
    expect((await failure(queries.formState(s.agentA.actor, s.ticket.id, s.groupB.id))).code).toBe('group_not_allowed');
    expect((await failure(queries.formState(s.agentA.actor, s.foreign.id))).status).toBe(404);
    expect((await failure(queries.formState(s.agentA.actor, 'nope'))).status).toBe(404);
  });

  it('flags frozen tickets so the forms can explain why they are disabled', async () => {
    const s = await scenario();
    let t = await tickets.assign(s.admin.actor, s.ticket.id, s.ticket.version, { assignedAgentId: s.agentA.agent.id });
    t = await tickets.changeStatus(s.admin.actor, t.id, t.version, { targetStatus: 'IN_PROGRESS' });
    t = await tickets.changeStatus(s.admin.actor, t.id, t.version, { targetStatus: 'UNRESOLVED', unresolvedReason: 'Vendor limitation, no fix' });
    expect((await queries.formState(s.admin.actor, t.id)).ticket.frozen).toBe(true);
  });
});

describe('history', () => {
  it('shows newest first with names instead of ids and a readable diff', async () => {
    const s = await scenario();
    let t = await tickets.update(s.admin.actor, s.ticket.id, s.ticket.version, { priority: 'URGENT' });
    t = await tickets.assign(s.admin.actor, t.id, t.version, { assignedAgentId: s.agentA.agent.id });
    t = await tickets.changeStatus(s.agentA.actor, t.id, t.version, { targetStatus: 'IN_PROGRESS' });
    t = await tickets.changeStatus(s.agentA.actor, t.id, t.version, { targetStatus: 'WAITING_CUSTOMER', reason: 'Asked for logs' });

    const page = await queries.history(s.agentA.actor, t.id);
    expect(page.total).toBe(5);
    expect(page.items.map((i) => i.kind)).toEqual(['STATUS_CHANGED', 'STATUS_CHANGED', 'ASSIGNED', 'UPDATED', 'CREATED']);

    const [waiting, started, assigned, updated, created] = page.items;
    expect(waiting).toMatchObject({ actor: s.agentA.user.displayName, reason: 'Asked for logs' });
    expect(waiting!.changes).toEqual([{ field: 'Status', from: 'In progress', to: 'Waiting for customer' }]);
    expect(started!.changes).toEqual([{ field: 'Status', from: 'New', to: 'In progress' }]);
    expect(assigned!.changes).toEqual([{ field: 'Assignee', from: null, to: s.agentA.user.displayName }]);
    expect(updated!.changes).toEqual([{ field: 'Priority', from: 'NORMAL', to: 'URGENT' }]);
    expect(created!.changes).toEqual([]);
    expect(JSON.stringify(page)).not.toContain(s.agentA.agent.id); // ids are resolved to names
  });

  it('shows the group name when a ticket moves, and pages 20 entries at a time', async () => {
    const s = await scenario();
    const moved = await tickets.assign(s.admin.actor, s.ticket.id, s.ticket.version, { groupId: s.groupB.id, assignedAgentId: s.agentB.agent.id });
    const [first] = (await queries.history(s.admin.actor, moved.id)).items;
    expect(first!.changes).toContainEqual({ field: 'Group', from: s.groupA.name, to: s.groupB.name });

    let version = moved.version;
    for (let i = 0; i < 20; i++) {
      version = (await tickets.update(s.admin.actor, moved.id, version, { description: `Revision ${i}` })).version;
    }
    const page1 = await queries.history(s.admin.actor, moved.id, 1);
    const page2 = await queries.history(s.admin.actor, moved.id, 2);
    expect(page1.total).toBe(22);
    expect(page1.items).toHaveLength(20);
    expect(page2.items).toHaveLength(2);
    expect(new Set([...page1.items, ...page2.items].map((i) => i.id)).size).toBe(22);
  });

  it('is unavailable for tickets outside the scope', async () => {
    const s = await scenario();
    expect((await failure(queries.history(s.agentA.actor, s.foreign.id))).status).toBe(404);
  });
});

describe('customerTickets', () => {
  it('lists only tickets the actor may see and pages by 10', async () => {
    const s = await scenario();
    for (let i = 0; i < 11; i++) {
      await tickets.create(s.admin.actor, { ...s.base, subject: `Follow-up ${i}`, groupId: s.groupA.id });
    }
    const adminAll = await queries.customerTickets(s.admin.actor, s.customer.id);
    expect(adminAll.total).toBe(13); // 11 + the two from the scenario
    expect(adminAll.items).toHaveLength(10);

    const agentView = await queries.customerTickets(s.agentA.actor, s.customer.id);
    expect(agentView.total).toBe(12); // the group B ticket is invisible, and not counted
    const subjects = [...agentView.items, ...(await queries.customerTickets(s.agentA.actor, s.customer.id, 2)).items].map((t) => t.subject);
    expect(subjects).not.toContain('Invoice mismatch');
    expect((await queries.customerTickets(s.agentA.actor, s.customer.id, 2)).items).toHaveLength(2);
  });

  it('returns an empty page for an unknown customer id', async () => {
    const s = await scenario();
    expect((await queries.customerTickets(s.admin.actor, 'not-a-uuid')).total).toBe(0);
  });
});

describe('dashboard', () => {
  it('counts within the actor scope, matching the ticket list filters', async () => {
    const s = await scenario();
    await tickets.assign(s.admin.actor, s.ticket.id, s.ticket.version, { assignedAgentId: s.agentA.agent.id });
    const mine = await queries.dashboard(s.agentA.actor);
    expect(mine.mine).toEqual({ count: 1, agentId: s.agentA.agent.id });
    expect(mine.total).toBeGreaterThanOrEqual(1);

    // a fresh group for a clean slate
    const lone = await fx.group();
    const loner = await fx.agent([lone]);
    expect(await queries.dashboard(loner.actor)).toMatchObject({ total: 0, unassigned: 0, waiting: { count: 0 }, unresolved: { count: 0 }, mine: { count: 0 } });
    await tickets.create(s.admin.actor, { ...s.base, subject: 'Lone ticket', groupId: lone.id });
    expect(await queries.dashboard(loner.actor)).toMatchObject({ total: 1, unassigned: 1 });
    expect((await queries.dashboard(s.admin.actor)).mine).toBeNull(); // ADMIN without an agent profile
  });

  it('counts waiting and unresolved tickets and exposes the status ids for the links', async () => {
    const lone = await fx.group();
    const admin = await fx.admin();
    const worker = await fx.agent([lone]);
    const customer = await fx.customer();
    const base = { description: 'd', customerId: customer.id, groupId: lone.id, assignedAgentId: worker.agent.id };
    const a = await tickets.create(admin.actor, { ...base, subject: 'Waiting one' });
    const b = await tickets.create(admin.actor, { ...base, subject: 'Unresolved one' });
    for (const [t, next] of [
      [a, { targetStatus: 'WAITING_CUSTOMER', reason: 'Asked for logs' }],
      [b, { targetStatus: 'UNRESOLVED', unresolvedReason: 'Vendor limitation, no fix' }],
    ] as const) {
      const started = await tickets.changeStatus(admin.actor, t.id, t.version, { targetStatus: 'IN_PROGRESS' });
      await tickets.changeStatus(admin.actor, started.id, started.version, next);
    }
    const d = await queries.dashboard(worker.actor);
    expect(d.waiting.count).toBe(1);
    expect(d.unresolved.count).toBe(1);
    expect(d.waiting.statusId).toBe((await prisma.ticketStatus.findUniqueOrThrow({ where: { code: 'WAITING_CUSTOMER' } })).id);
    expect(d.unresolved.statusId).toBe((await prisma.ticketStatus.findUniqueOrThrow({ where: { code: 'UNRESOLVED' } })).id);
  });
});
