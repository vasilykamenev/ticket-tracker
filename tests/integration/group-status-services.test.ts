import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '../../src/domain/errors.js';
import { GroupService } from '../../src/domain/groups/group-service.js';
import { StatusService } from '../../src/domain/statuses/status-service.js';
import { TicketQueries } from '../../src/domain/tickets/ticket-queries.js';
import { TicketService } from '../../src/domain/tickets/ticket-service.js';
import { Fixtures } from './helpers/fixtures.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for integration tests (see .env.example)');

const prisma = new PrismaClient();
const fx = new Fixtures(prisma);
const groups = new GroupService(prisma);
const statuses = new StatusService(prisma);
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

let admin: Awaited<ReturnType<Fixtures['admin']>>;
const adHocStatusIds: string[] = [];
let statusSeq = 0;

/** A status row that is not one of the six system statuses, so tests never disturb the real ones. */
async function adHocStatus() {
  const status = await prisma.ticketStatus.create({
    data: { code: `TEST_${Date.now()}_${statusSeq++}`, name: 'Test status', color: '#123456', sortOrder: 999 },
  });
  adHocStatusIds.push(status.id);
  return status;
}

beforeAll(async () => {
  await fx.init();
  admin = await fx.admin();
});

afterAll(async () => {
  await prisma.ticket.deleteMany({ where: { statusId: { in: adHocStatusIds } } });
  await prisma.ticketStatus.deleteMany({ where: { id: { in: adHocStatusIds } } });
  await fx.cleanup();
  await prisma.$disconnect();
});

describe('groups', () => {
  it('creates a group with an immutable, well-formed code', async () => {
    const code = `QA_${Date.now()}`;
    const group = await groups.create(admin.actor, { code, name: 'Quality', description: '  Testing  ' });
    fx.trackGroup(group.id);
    expect(group).toMatchObject({ code, name: 'Quality', description: 'Testing', isActive: true });

    expect((await failure(groups.create(admin.actor, { code, name: 'Again' }))).details).toHaveProperty('code'); // duplicate
    for (const bad of ['lower', '1ABC', 'A', 'HAS SPACE', 'A'.repeat(41)]) {
      expect((await failure(groups.create(admin.actor, { code: bad, name: 'Bad' }))).code, bad).toBe('validation');
    }
    expect((await failure(groups.update(admin.actor, group.id, { code: 'OTHER' }))).code).toBe('validation'); // the code never changes
  });

  it('edits name and description and rejects an edit that changes nothing', async () => {
    const group = await fx.group();
    const updated = await groups.update(admin.actor, group.id, { name: 'Renamed', description: '' });
    expect(updated).toMatchObject({ name: 'Renamed', description: null });
    expect((await failure(groups.update(admin.actor, group.id, {}))).code).toBe('validation');
  });

  it('deactivates only without active tickets, and can be reactivated', async () => {
    const group = await fx.group();
    const customer = await fx.customer();
    const ticket = await tickets.create(admin.actor, { subject: 'Blocks deactivation', description: 'd', customerId: customer.id, groupId: group.id });
    expect((await failure(groups.update(admin.actor, group.id, { isActive: false }))).code).toBe('has_active_tickets');
    expect((await prisma.supportGroup.findUniqueOrThrow({ where: { id: group.id } })).isActive).toBe(true);

    // the only active ticket goes away (history first: foreign keys are RESTRICT)
    await prisma.ticketHistory.deleteMany({ where: { ticketId: ticket.id } });
    await prisma.ticket.delete({ where: { id: ticket.id } });
    expect((await groups.update(admin.actor, group.id, { isActive: false })).isActive).toBe(false);
    expect((await groups.update(admin.actor, group.id, { isActive: true })).isActive).toBe(true);
  });

  it('adds members who are active, to active groups, once', async () => {
    const group = await fx.group();
    const inactiveGroup = await fx.group({ active: false });
    const agent = await fx.agent([]);
    const sleeping = await fx.agent([], { active: false });

    await groups.addMember(admin.actor, agent.agent.id, group.id);
    expect(await prisma.agentGroup.count({ where: { agentId: agent.agent.id, groupId: group.id } })).toBe(1);
    expect((await failure(groups.addMember(admin.actor, agent.agent.id, group.id))).details).toHaveProperty('agentId'); // already a member
    expect((await failure(groups.addMember(admin.actor, sleeping.agent.id, group.id))).details).toHaveProperty('agentId');
    expect((await failure(groups.addMember(admin.actor, agent.agent.id, inactiveGroup.id))).details).toHaveProperty('groupId');
    expect((await failure(groups.addMember(admin.actor, '00000000-0000-4000-8000-000000000000', group.id))).status).toBe(404);
  });

  it('removes members, but not while they hold active tickets in that group', async () => {
    const group = await fx.group();
    const customer = await fx.customer();
    const agent = await fx.agent([group]);
    await tickets.create(admin.actor, { subject: 'Held by member', description: 'd', customerId: customer.id, groupId: group.id, assignedAgentId: agent.agent.id });
    expect((await failure(groups.removeMember(admin.actor, agent.agent.id, group.id))).code).toBe('has_active_tickets');

    const other = await fx.agent([group]);
    await groups.removeMember(admin.actor, other.agent.id, group.id);
    expect(await prisma.agentGroup.count({ where: { agentId: other.agent.id, groupId: group.id } })).toBe(0);
    expect((await failure(groups.removeMember(admin.actor, other.agent.id, group.id))).status).toBe(404); // no longer a member
  });

  it('is for administrators only', async () => {
    const group = await fx.group();
    const agent = await fx.agent([group]);
    expect((await failure(groups.create(agent.actor, { code: 'NOPE', name: 'Nope' }))).code).toBe('admin_only');
    expect((await failure(groups.update(agent.actor, group.id, { name: 'Hijack' }))).code).toBe('admin_only');
    expect((await failure(groups.addMember(agent.actor, agent.agent.id, group.id))).code).toBe('admin_only');
  });
});

describe('statuses', () => {
  it('changes name, color and order', async () => {
    const status = await adHocStatus();
    const updated = await statuses.update(admin.actor, status.id, { name: 'Renamed', color: '#AABBCC', sortOrder: 5 });
    expect(updated).toMatchObject({ name: 'Renamed', color: '#AABBCC', sortOrder: 5, code: status.code });
    for (const bad of [{ color: 'red' }, { color: '#12345' }, { sortOrder: -1 }, { sortOrder: 1.5 }, { name: ' ' }, { code: 'NEW' }]) {
      expect((await failure(statuses.update(admin.actor, status.id, bad))).code, JSON.stringify(bad)).toBe('validation');
    }
  });

  it('never deactivates NEW, nor a status that tickets still use', async () => {
    const newStatus = await prisma.ticketStatus.findUniqueOrThrow({ where: { code: 'NEW' } });
    expect((await failure(statuses.update(admin.actor, newStatus.id, { isActive: false }))).details).toHaveProperty('isActive');

    const used = await adHocStatus();
    const group = await fx.group();
    const customer = await fx.customer();
    await prisma.ticket.create({ data: { subject: 'Uses a status', description: 'd', customerId: customer.id, groupId: group.id, statusId: used.id, createdByUserId: admin.user.id } });
    expect((await failure(statuses.update(admin.actor, used.id, { isActive: false }))).code).toBe('status_in_use');
    expect((await prisma.ticketStatus.findUniqueOrThrow({ where: { id: used.id } })).isActive).toBe(true);
  });

  it('deactivates an unused status and reactivates it', async () => {
    const status = await adHocStatus();
    expect((await statuses.update(admin.actor, status.id, { isActive: false })).isActive).toBe(false);
    expect((await statuses.update(admin.actor, status.id, { isActive: true })).isActive).toBe(true);
  });

  it('is for administrators only, and unknown ids are 404', async () => {
    const status = await adHocStatus();
    const agent = await fx.agent([]);
    expect((await failure(statuses.update(agent.actor, status.id, { name: 'Hijack' }))).code).toBe('admin_only');
    expect((await failure(statuses.update(admin.actor, '00000000-0000-4000-8000-000000000000', { name: 'Ghost' }))).status).toBe(404);
    expect((await failure(statuses.update(admin.actor, 'not-a-uuid', { name: 'Ghost' }))).status).toBe(404);
  });
});

describe('a deactivated status in the workflow', () => {
  it('is no longer a valid target and is not offered in the forms', async () => {
    const group = await fx.group();
    const customer = await fx.customer();
    const worker = await fx.agent([group]);
    const t = await tickets.create(admin.actor, { subject: 'Workflow vs status', description: 'd', customerId: customer.id, groupId: group.id, assignedAgentId: worker.agent.id });
    const started = await tickets.changeStatus(admin.actor, t.id, t.version, { targetStatus: 'IN_PROGRESS' });

    const waiting = await prisma.ticketStatus.findUniqueOrThrow({ where: { code: 'WAITING_CUSTOMER' } });
    // Flipped directly: StatusService would refuse if any ticket used it, and the point here is the workflow.
    await prisma.ticketStatus.update({ where: { id: waiting.id }, data: { isActive: false } });
    try {
      const err = await failure(tickets.changeStatus(admin.actor, started.id, started.version, { targetStatus: 'WAITING_CUSTOMER', reason: 'Asked for logs' }));
      expect(err.details).toHaveProperty('targetStatus');
      const offered = (await queries.formState(admin.actor, started.id)).targets.map((x) => x.code);
      expect(offered).not.toContain('WAITING_CUSTOMER');
      expect(offered).toContain('RESOLVED');
    } finally {
      await prisma.ticketStatus.update({ where: { id: waiting.id }, data: { isActive: true } });
    }
    const after = await tickets.changeStatus(admin.actor, started.id, started.version, { targetStatus: 'WAITING_CUSTOMER', reason: 'Asked for logs' });
    expect(after.status.code).toBe('WAITING_CUSTOMER');
  });
});
