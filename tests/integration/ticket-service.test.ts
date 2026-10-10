import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '../../src/domain/errors.js';
import { GroupService } from '../../src/domain/groups/group-service.js';
import { TicketService } from '../../src/domain/tickets/ticket-service.js';
import { AgentService } from '../../src/domain/users/agent-service.js';
import { Fixtures } from './helpers/fixtures.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for integration tests (see .env.example)');

const prisma = new PrismaClient();
const fx = new Fixtures(prisma);
const tickets = new TicketService(prisma);
const groups = new GroupService(prisma);
const agents = new AgentService(prisma);

const RESOLUTION = 'Restarted the sync job and verified';
const REASON = 'Customer confirmed the workaround';

async function failure(promise: Promise<unknown>): Promise<DomainError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, 'expected a DomainError').toBeInstanceOf(DomainError);
  return err as DomainError;
}

async function historyKinds(ticketId: string): Promise<string[]> {
  const rows = await prisma.ticketHistory.findMany({ where: { ticketId }, orderBy: { createdAt: 'asc' } });
  return rows.map((r) => r.kind);
}

beforeAll(async () => {
  await fx.init();
});

afterAll(async () => {
  await fx.cleanup();
  await prisma.$disconnect();
});

/** One group, one admin, an agent in the group, and a NEW ticket created by the admin. */
async function scenario() {
  const group = await fx.group();
  const customer = await fx.customer();
  const admin = await fx.admin();
  const agent = await fx.agent([group]);
  const ticket = await tickets.create(admin.actor, {
    subject: 'Cannot export report',
    description: 'Export button does nothing',
    customerId: customer.id,
    groupId: group.id,
  });
  return { group, customer, admin, agent, ticket };
}

/** Same, but the ticket is already IN_PROGRESS and assigned to the agent. */
async function inProgress() {
  const s = await scenario();
  const assigned = await tickets.assign(s.admin.actor, s.ticket.id, s.ticket.version, { assignedAgentId: s.agent.agent.id });
  const started = await tickets.changeStatus(s.admin.actor, assigned.id, assigned.version, { targetStatus: 'IN_PROGRESS' });
  return { ...s, ticket: started };
}

describe('create', () => {
  it('creates a NEW unassigned ticket, versioned, with a CREATED history entry', async () => {
    const { ticket, admin } = await scenario();
    expect(ticket.status.code).toBe('NEW');
    expect(ticket.version).toBe(1);
    expect(ticket.assignedAgentId).toBeNull();
    expect(ticket.createdByUserId).toBe(admin.actor.userId);
    expect(ticket.number).toBeGreaterThan(0);
    expect(await historyKinds(ticket.id)).toEqual(['CREATED']);
  });

  it('lets an AGENT create only in their own groups', async () => {
    const own = await fx.group();
    const foreign = await fx.group();
    const customer = await fx.customer();
    const agent = await fx.agent([own]);
    const input = { subject: 'Billing question', description: 'Invoice is wrong', customerId: customer.id };
    await expect(tickets.create(agent.actor, { ...input, groupId: own.id })).resolves.toBeTruthy();
    expect((await failure(tickets.create(agent.actor, { ...input, groupId: foreign.id }))).code).toBe('group_not_allowed');
  });

  it('rejects inactive customers, inactive groups and invalid assignees', async () => {
    const group = await fx.group();
    const inactiveGroup = await fx.group({ active: false });
    const other = await fx.group();
    const admin = await fx.admin();
    const customer = await fx.customer();
    const inactiveCustomer = await fx.customer({ active: false });
    const outsider = await fx.agent([other]);
    const base = { subject: 'Valid subject', description: 'd', customerId: customer.id, groupId: group.id };

    expect((await failure(tickets.create(admin.actor, { ...base, customerId: inactiveCustomer.id }))).details).toHaveProperty('customerId');
    expect((await failure(tickets.create(admin.actor, { ...base, groupId: inactiveGroup.id }))).details).toHaveProperty('groupId');
    expect((await failure(tickets.create(admin.actor, { ...base, assignedAgentId: outsider.agent.id }))).details).toHaveProperty('assignedAgentId');
  });

  it('rejects fields the client must not set', async () => {
    const { group, customer, admin } = await scenario();
    const err = await failure(
      tickets.create(admin.actor, { subject: 'Valid subject', description: 'd', customerId: customer.id, groupId: group.id, version: 9 }),
    );
    expect(err.code).toBe('validation');
  });
});

describe('scope', () => {
  it('shows an AGENT only tickets of their groups and hides the rest as 404', async () => {
    const { ticket, group } = await scenario();
    const member = await fx.agent([group]);
    const outsider = await fx.agent([await fx.group()]);
    const loner = await fx.agent([]);

    expect((await tickets.get(member.actor, ticket.id)).id).toBe(ticket.id);
    expect((await failure(tickets.get(outsider.actor, ticket.id))).status).toBe(404);
    expect((await failure(tickets.get(loner.actor, ticket.id))).status).toBe(404);
    expect((await failure(tickets.get(member.actor, 'not-a-uuid'))).status).toBe(404);
  });

  it('treats every write on an out-of-scope ticket as 404 too', async () => {
    const { ticket } = await scenario();
    const outsider = await fx.agent([await fx.group()]);
    const attempts = await Promise.all([
      failure(tickets.update(outsider.actor, ticket.id, 1, { priority: 'HIGH' })),
      failure(tickets.assign(outsider.actor, ticket.id, 1, { assignedAgentId: null })),
      failure(tickets.changeStatus(outsider.actor, ticket.id, 1, { targetStatus: 'IN_PROGRESS' })),
    ]);
    for (const err of attempts) expect(err.status).toBe(404);
  });
});

describe('update and optimistic locking', () => {
  it('edits fields, bumps the version and records before/after', async () => {
    const { ticket, admin } = await scenario();
    const updated = await tickets.update(admin.actor, ticket.id, ticket.version, { priority: 'URGENT', description: 'New text' });
    expect(updated.version).toBe(ticket.version + 1);
    expect(updated.priority).toBe('URGENT');
    const entry = await prisma.ticketHistory.findFirstOrThrow({ where: { ticketId: ticket.id, kind: 'UPDATED' } });
    expect(entry.before).toMatchObject({ priority: 'NORMAL' });
    expect(entry.after).toMatchObject({ priority: 'URGENT' });
  });

  it('returns 409 for a stale version and leaves the ticket and history untouched', async () => {
    const { ticket, admin } = await scenario();
    await tickets.update(admin.actor, ticket.id, ticket.version, { priority: 'HIGH' });
    const err = await failure(tickets.update(admin.actor, ticket.id, ticket.version, { priority: 'LOW' }));
    expect(err.status).toBe(409);
    expect(err.code).toBe('version_conflict');
    const now = await tickets.get(admin.actor, ticket.id);
    expect(now.priority).toBe('HIGH');
    expect(await historyKinds(ticket.id)).toEqual(['CREATED', 'UPDATED']);
  });

  it('lets exactly one of two concurrent writers with the same version win', async () => {
    const { ticket, admin } = await inProgress();
    const attempt = (reason: string) => tickets.changeStatus(admin.actor, ticket.id, ticket.version, { targetStatus: 'WAITING_CUSTOMER', reason });
    const results = await Promise.allSettled([attempt('first waiting reason'), attempt('second waiting reason')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((loser.reason as DomainError).code).toBe('version_conflict');
    const waiting = (await prisma.ticketHistory.findMany({ where: { ticketId: ticket.id, kind: 'STATUS_CHANGED' } })).filter(
      (h) => (h.after as { status?: string } | null)?.status === 'WAITING_CUSTOMER',
    );
    expect(waiting).toHaveLength(1);
  });

  it('refuses to edit CLOSED and UNRESOLVED tickets', async () => {
    const s = await inProgress();
    const unresolved = await tickets.changeStatus(s.admin.actor, s.ticket.id, s.ticket.version, {
      targetStatus: 'UNRESOLVED',
      unresolvedReason: 'Blocked by a vendor limitation',
    });
    expect((await failure(tickets.update(s.admin.actor, unresolved.id, unresolved.version, { priority: 'LOW' }))).code).toBe('ticket_frozen');
    expect((await failure(tickets.assign(s.admin.actor, unresolved.id, unresolved.version, { assignedAgentId: s.agent.agent.id }))).code).toBe('ticket_frozen');
  });
});

describe('assignment', () => {
  it('assigns an active member and records ASSIGNED', async () => {
    const { ticket, admin, agent } = await scenario();
    const updated = await tickets.assign(admin.actor, ticket.id, ticket.version, { assignedAgentId: agent.agent.id });
    expect(updated.assignedAgentId).toBe(agent.agent.id);
    expect(await historyKinds(ticket.id)).toEqual(['CREATED', 'ASSIGNED']);
  });

  it('rejects non-members and inactive agents', async () => {
    const { ticket, admin } = await scenario();
    const outsider = await fx.agent([await fx.group()]);
    const sleeping = await fx.agent([{ id: ticket.groupId }], { active: false });
    expect((await failure(tickets.assign(admin.actor, ticket.id, ticket.version, { assignedAgentId: outsider.agent.id }))).details).toHaveProperty('assignedAgentId');
    expect((await failure(tickets.assign(admin.actor, ticket.id, ticket.version, { assignedAgentId: sleeping.agent.id }))).details).toHaveProperty('assignedAgentId');
  });

  it('lets a NEW ticket be unassigned, but not a ticket in progress', async () => {
    const s = await scenario();
    const assigned = await tickets.assign(s.admin.actor, s.ticket.id, s.ticket.version, { assignedAgentId: s.agent.agent.id });
    const cleared = await tickets.assign(s.admin.actor, assigned.id, assigned.version, { assignedAgentId: null });
    expect(cleared.assignedAgentId).toBeNull();

    const p = await inProgress();
    expect((await failure(tickets.assign(p.admin.actor, p.ticket.id, p.ticket.version, { assignedAgentId: null }))).details).toHaveProperty('assignedAgentId');
  });

  it('moves a ticket to another group only with a member of that group', async () => {
    const p = await inProgress();
    const target = await fx.group();
    const targetAgent = await fx.agent([target]);

    // keeping the old assignee fails: they are not in the new group
    expect((await failure(tickets.assign(p.admin.actor, p.ticket.id, p.ticket.version, { groupId: target.id }))).details).toHaveProperty('assignedAgentId');
    const moved = await tickets.assign(p.admin.actor, p.ticket.id, p.ticket.version, { groupId: target.id, assignedAgentId: targetAgent.agent.id });
    expect(moved.groupId).toBe(target.id);
    expect(moved.assignedAgentId).toBe(targetAgent.agent.id);
  });

  it('does not let an AGENT move a ticket into a group they do not belong to', async () => {
    const s = await scenario();
    const foreign = await fx.group();
    const foreignAgent = await fx.agent([foreign]);
    const err = await failure(tickets.assign(s.agent.actor, s.ticket.id, s.ticket.version, { groupId: foreign.id, assignedAgentId: foreignAgent.agent.id }));
    expect(err.code).toBe('group_not_allowed');
  });

  it('rejects an assignment that changes nothing', async () => {
    const { ticket, admin } = await scenario();
    expect((await failure(tickets.assign(admin.actor, ticket.id, ticket.version, { assignedAgentId: null }))).code).toBe('no_change');
  });
});

describe('status workflow', () => {
  it('walks NEW -> IN_PROGRESS -> WAITING_CUSTOMER -> IN_PROGRESS -> RESOLVED -> CLOSED with history', async () => {
    const s = await scenario();
    let t = await tickets.assign(s.agent.actor, s.ticket.id, s.ticket.version, { assignedAgentId: s.agent.agent.id });
    t = await tickets.changeStatus(s.agent.actor, t.id, t.version, { targetStatus: 'IN_PROGRESS' });
    t = await tickets.changeStatus(s.agent.actor, t.id, t.version, { targetStatus: 'WAITING_CUSTOMER', reason: 'Asked for logs' });
    t = await tickets.changeStatus(s.agent.actor, t.id, t.version, { targetStatus: 'IN_PROGRESS' });
    t = await tickets.changeStatus(s.agent.actor, t.id, t.version, { targetStatus: 'RESOLVED', resolution: RESOLUTION });
    expect(t.status.code).toBe('RESOLVED');
    expect(t.resolution).toBe(RESOLUTION);
    expect(t.resolvedAt).toBeInstanceOf(Date);

    t = await tickets.changeStatus(s.admin.actor, t.id, t.version, { targetStatus: 'CLOSED', reason: 'Confirmed by customer' });
    expect(t.status.code).toBe('CLOSED');
    expect(t.closedAt).toBeInstanceOf(Date);
    expect(t.resolution).toBe(RESOLUTION); // the confirmed solution is retained

    expect(await historyKinds(t.id)).toEqual(['CREATED', 'ASSIGNED', ...Array<string>(5).fill('STATUS_CHANGED')]);
    expect(t.version).toBe(s.ticket.version + 6);
  });

  it('rejects transitions that are not in the matrix', async () => {
    const s = await scenario();
    expect((await failure(tickets.changeStatus(s.admin.actor, s.ticket.id, s.ticket.version, { targetStatus: 'RESOLVED', resolution: RESOLUTION }))).code).toBe('invalid_transition');
    expect((await failure(tickets.changeStatus(s.admin.actor, s.ticket.id, s.ticket.version, { targetStatus: 'CLOSED' }))).code).toBe('invalid_transition');
  });

  it('refuses to start work without an assignee or with an unusable one', async () => {
    const s = await scenario();
    const err = await failure(tickets.changeStatus(s.admin.actor, s.ticket.id, s.ticket.version, { targetStatus: 'IN_PROGRESS' }));
    expect(err.details).toHaveProperty('assignedAgentId');
  });

  it('requires a waiting reason, a resolution of 10+ characters and an unresolved reason', async () => {
    const s = await inProgress();
    const go = (input: object) => tickets.changeStatus(s.admin.actor, s.ticket.id, s.ticket.version, input);
    expect((await failure(go({ targetStatus: 'WAITING_CUSTOMER' }))).details).toHaveProperty('reason');
    expect((await failure(go({ targetStatus: 'RESOLVED' }))).details).toHaveProperty('resolution');
    expect((await failure(go({ targetStatus: 'RESOLVED', resolution: 'short' }))).code).toBe('validation');
    expect((await failure(go({ targetStatus: 'UNRESOLVED' }))).details).toHaveProperty('unresolvedReason');
  });

  it('accepts outcome fields only for the matching target status', async () => {
    const s = await inProgress();
    const go = (input: object) => tickets.changeStatus(s.admin.actor, s.ticket.id, s.ticket.version, input);
    expect((await failure(go({ targetStatus: 'WAITING_CUSTOMER', reason: REASON, resolution: RESOLUTION }))).details).toHaveProperty('resolution');
    expect((await failure(go({ targetStatus: 'RESOLVED', resolution: RESOLUTION, unresolvedReason: RESOLUTION }))).details).toHaveProperty('unresolvedReason');
  });

  it('keeps ADMIN-only transitions away from agents', async () => {
    const s = await inProgress();
    const resolved = await tickets.changeStatus(s.agent.actor, s.ticket.id, s.ticket.version, { targetStatus: 'RESOLVED', resolution: RESOLUTION });
    expect((await failure(tickets.changeStatus(s.agent.actor, resolved.id, resolved.version, { targetStatus: 'CLOSED' }))).code).toBe('admin_only');
    const closed = await tickets.changeStatus(s.admin.actor, resolved.id, resolved.version, { targetStatus: 'CLOSED' });
    expect((await failure(tickets.changeStatus(s.agent.actor, closed.id, closed.version, { targetStatus: 'IN_PROGRESS', reason: REASON }))).code).toBe('admin_only');
  });

  it('records UNRESOLVED distinctly and reopens it only to IN_PROGRESS with a reason', async () => {
    const s = await inProgress();
    const unresolved = await tickets.changeStatus(s.agent.actor, s.ticket.id, s.ticket.version, {
      targetStatus: 'UNRESOLVED',
      unresolvedReason: 'Vendor limitation, no fix available',
    });
    expect(unresolved.status.code).toBe('UNRESOLVED');
    expect(unresolved.unresolvedAt).toBeInstanceOf(Date);
    expect(unresolved.resolvedAt).toBeNull();

    expect((await failure(tickets.changeStatus(s.admin.actor, unresolved.id, unresolved.version, { targetStatus: 'RESOLVED', resolution: RESOLUTION }))).code).toBe('invalid_transition');
    expect((await failure(tickets.changeStatus(s.admin.actor, unresolved.id, unresolved.version, { targetStatus: 'CLOSED' }))).code).toBe('invalid_transition');
    expect((await failure(tickets.changeStatus(s.admin.actor, unresolved.id, unresolved.version, { targetStatus: 'IN_PROGRESS' }))).details).toHaveProperty('reason');

    const reopened = await tickets.changeStatus(s.agent.actor, unresolved.id, unresolved.version, { targetStatus: 'IN_PROGRESS', reason: 'Vendor shipped a fix' });
    expect(reopened.status.code).toBe('IN_PROGRESS');
    expect(reopened.unresolvedReason).toBeNull();
    expect(reopened.unresolvedAt).toBeNull();

    // the cleared outcome is preserved in history
    const entry = await prisma.ticketHistory.findFirstOrThrow({ where: { ticketId: reopened.id, reason: 'Vendor shipped a fix' } });
    expect(entry.before).toMatchObject({ status: 'UNRESOLVED', unresolvedReason: 'Vendor limitation, no fix available' });
    expect(entry.after).toMatchObject({ status: 'IN_PROGRESS', unresolvedReason: null });
  });

  it('reopens a CLOSED ticket only with a valid assignee, supplied atomically', async () => {
    const s = await inProgress();
    const resolved = await tickets.changeStatus(s.admin.actor, s.ticket.id, s.ticket.version, { targetStatus: 'RESOLVED', resolution: RESOLUTION });
    const closed = await tickets.changeStatus(s.admin.actor, resolved.id, resolved.version, { targetStatus: 'CLOSED' });

    // the historical assignee leaves the group; ADMIN can still close/reopen history, but reopening needs a valid agent
    await prisma.agentGroup.deleteMany({ where: { agentId: s.agent.agent.id } });
    const noAssignee = await failure(tickets.changeStatus(s.admin.actor, closed.id, closed.version, { targetStatus: 'IN_PROGRESS', reason: REASON }));
    expect(noAssignee.details).toHaveProperty('assignedAgentId');

    const replacement = await fx.agent([{ id: closed.groupId }]);
    const reopened = await tickets.changeStatus(s.admin.actor, closed.id, closed.version, {
      targetStatus: 'IN_PROGRESS',
      reason: REASON,
      assignedAgentId: replacement.agent.id,
    });
    expect(reopened.assignedAgentId).toBe(replacement.agent.id);
    expect(reopened.closedAt).toBeNull();
    expect(reopened.resolution).toBeNull();
  });

  it('refuses to reopen into an inactive group', async () => {
    const s = await inProgress();
    const resolved = await tickets.changeStatus(s.admin.actor, s.ticket.id, s.ticket.version, { targetStatus: 'RESOLVED', resolution: RESOLUTION });
    await prisma.supportGroup.update({ where: { id: resolved.groupId }, data: { isActive: false } });
    const err = await failure(tickets.changeStatus(s.admin.actor, resolved.id, resolved.version, { targetStatus: 'IN_PROGRESS', reason: REASON }));
    expect(err.details).toHaveProperty('groupId');
    // closing a RESOLVED ticket does not need the group to be active
    const closed = await tickets.changeStatus(s.admin.actor, resolved.id, resolved.version, { targetStatus: 'CLOSED' });
    expect(closed.status.code).toBe('CLOSED');
  });

  it('is atomic: a rejected change leaves no partial ticket or history changes', async () => {
    const s = await inProgress();
    const before = await prisma.ticketHistory.count({ where: { ticketId: s.ticket.id } });
    await failure(tickets.changeStatus(s.admin.actor, s.ticket.id, s.ticket.version, { targetStatus: 'RESOLVED', resolution: 'short' }));
    await failure(tickets.changeStatus(s.admin.actor, s.ticket.id, s.ticket.version + 5, { targetStatus: 'WAITING_CUSTOMER', reason: REASON }));
    const after = await tickets.get(s.admin.actor, s.ticket.id);
    expect(after.version).toBe(s.ticket.version);
    expect(after.status.code).toBe('IN_PROGRESS');
    expect(await prisma.ticketHistory.count({ where: { ticketId: s.ticket.id } })).toBe(before);
  });
});

describe('structural guards', () => {
  it('refuses to deactivate an agent who holds active tickets, and allows it after reassignment', async () => {
    const s = await inProgress();
    const err = await failure(agents.deactivateAgent(s.admin.actor, s.agent.agent.id));
    expect(err.code).toBe('has_active_tickets');

    const other = await fx.agent([{ id: s.ticket.groupId }]);
    await tickets.assign(s.admin.actor, s.ticket.id, s.ticket.version, { assignedAgentId: other.agent.id });
    await agents.deactivateAgent(s.admin.actor, s.agent.agent.id);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: s.agent.agent.id } })).isActive).toBe(false);
  });

  it('ignores RESOLVED, CLOSED and UNRESOLVED tickets when deactivating an agent', async () => {
    const s = await inProgress();
    await tickets.changeStatus(s.admin.actor, s.ticket.id, s.ticket.version, { targetStatus: 'RESOLVED', resolution: RESOLUTION });
    await agents.deactivateAgent(s.admin.actor, s.agent.agent.id);
  });

  it('refuses to remove a member with active tickets in that group', async () => {
    const s = await inProgress();
    expect((await failure(groups.removeMember(s.admin.actor, s.agent.agent.id, s.group.id))).code).toBe('has_active_tickets');
  });

  it('refuses to deactivate a group with active tickets', async () => {
    const s = await scenario();
    expect((await failure(groups.deactivateGroup(s.admin.actor, s.group.id))).code).toBe('has_active_tickets');
    const empty = await fx.group();
    await groups.deactivateGroup(s.admin.actor, empty.id);
  });

  it('allows these operations to ADMIN only', async () => {
    const s = await scenario();
    expect((await failure(agents.deactivateAgent(s.agent.actor, s.agent.agent.id))).code).toBe('admin_only');
    expect((await failure(groups.deactivateGroup(s.agent.actor, s.group.id))).code).toBe('admin_only');
    expect((await failure(groups.removeMember(s.agent.actor, s.agent.agent.id, s.group.id))).code).toBe('admin_only');
  });

  it('never leaves an active ticket assigned to an agent deactivated concurrently', async () => {
    for (let i = 0; i < 6; i++) {
      const group = await fx.group();
      const customer = await fx.customer();
      const admin = await fx.admin();
      const agent = await fx.agent([group]);
      const ticket = await tickets.create(admin.actor, { subject: 'Race condition', description: 'd', customerId: customer.id, groupId: group.id });

      const results = await Promise.allSettled([
        tickets.assign(admin.actor, ticket.id, ticket.version, { assignedAgentId: agent.agent.id }),
        agents.deactivateAgent(admin.actor, agent.agent.id),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled'), `iteration ${i}`).toHaveLength(1);

      const [t, a] = await Promise.all([
        prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } }),
        prisma.agent.findUniqueOrThrow({ where: { id: agent.agent.id } }),
      ]);
      expect(t.assignedAgentId !== null && !a.isActive, `iteration ${i}: active ticket on inactive agent`).toBe(false);
    }
  });
});
