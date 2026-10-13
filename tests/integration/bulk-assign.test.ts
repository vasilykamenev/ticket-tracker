import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BulkRejectedError } from '../../src/domain/errors.js';
import { TicketQueries } from '../../src/domain/tickets/ticket-queries.js';
import { TicketService } from '../../src/domain/tickets/ticket-service.js';
import { CommentQueries } from '../../src/domain/comments/comment-queries.js';
import { CommentService } from '../../src/domain/comments/comment-service.js';
import { Fixtures } from './helpers/fixtures.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for integration tests (see .env.example)');

const prisma = new PrismaClient();
const fx = new Fixtures(prisma);
const tickets = new TicketService(prisma);
const queries = new TicketQueries(prisma);
const comments = new CommentService(prisma);
const commentQueries = new CommentQueries(prisma);

beforeAll(async () => {
  await fx.init();
});

afterAll(async () => {
  await fx.cleanup();
  await prisma.$disconnect();
});

/** Two groups, an agent in each, and a helper that creates NEW tickets in the first group. */
async function scenario() {
  const groupA = await fx.group();
  const groupB = await fx.group();
  const customer = await fx.customer();
  const admin = await fx.admin();
  const agentA = await fx.agent([groupA]);
  const agentB = await fx.agent([groupB]);
  const make = async (count: number) => {
    const made = [];
    for (let i = 0; i < count; i++) {
      made.push(await tickets.create(admin.actor, { subject: `Bulk assign ${i + 1}`, description: 'd', customerId: customer.id, groupId: groupA.id }));
    }
    return made;
  };
  const pairs = (list: Array<{ id: string; version: number }>) => list.map((t) => ({ id: t.id, version: t.version }));
  return { groupA, groupB, customer, admin, agentA, agentB, make, pairs };
}

describe('bulkAssign', () => {
  it('assigns every selected ticket and writes one ASSIGNED history entry for each', async () => {
    const s = await scenario();
    const batch = await s.make(5);
    const result = await tickets.bulkAssign(s.admin.actor, { items: s.pairs(batch), groupId: s.groupA.id, assignedAgentId: s.agentA.agent.id });
    expect(result.changed).toHaveLength(5);
    for (const t of batch) {
      const row = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
      expect(row.assignedAgentId).toBe(s.agentA.agent.id);
      expect(row.version).toBe(t.version + 1);
      expect(await prisma.ticketHistory.count({ where: { ticketId: t.id, kind: 'ASSIGNED' } })).toBe(1);
    }
  });

  it('moves tickets to another group together with an assignee of that group', async () => {
    const s = await scenario();
    const batch = await s.make(2);
    await tickets.bulkAssign(s.admin.actor, { items: s.pairs(batch), groupId: s.groupB.id, assignedAgentId: s.agentB.agent.id });
    for (const t of batch) expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).groupId).toBe(s.groupB.id);
  });

  it('is all or nothing: an assignee who is not in the group refuses the batch and changes nothing', async () => {
    const s = await scenario();
    const batch = await s.make(3);
    const err = await tickets.bulkAssign(s.admin.actor, { items: s.pairs(batch), groupId: s.groupA.id, assignedAgentId: s.agentB.agent.id }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BulkRejectedError);
    for (const t of batch) {
      const row = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
      expect(row.assignedAgentId).toBeNull();
      expect(row.version).toBe(t.version);
    }
  });

  it('refuses a stale version instead of overwriting', async () => {
    const s = await scenario();
    const [first, second] = await s.make(2);
    await tickets.assign(s.admin.actor, first!.id, first!.version, { assignedAgentId: s.agentA.agent.id });
    await expect(tickets.bulkAssign(s.admin.actor, { items: s.pairs([first!, second!]), assignedAgentId: s.agentA.agent.id })).rejects.toBeInstanceOf(BulkRejectedError);
  });

  it('refuses more than 100 tickets before touching the database', async () => {
    const s = await scenario();
    const items = Array.from({ length: 101 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, version: 1 }));
    await expect(tickets.bulkAssign(s.admin.actor, { items, assignedAgentId: s.agentA.agent.id })).rejects.toMatchObject({ code: 'batch_too_large' });
  });
});

describe('bulkSetPriority', () => {
  it('changes the priority of every selected ticket with one UPDATED history entry each', async () => {
    const s = await scenario();
    const batch = await s.make(4);
    const result = await tickets.bulkSetPriority(s.admin.actor, { items: s.pairs(batch), priority: 'URGENT' });
    expect(result.changed).toHaveLength(4);
    for (const t of batch) {
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).priority).toBe('URGENT');
      expect(await prisma.ticketHistory.count({ where: { ticketId: t.id, kind: 'UPDATED' } })).toBe(1);
    }
  });

  it('refuses the whole batch when one ticket already has that priority', async () => {
    const s = await scenario();
    const [a, b] = await s.make(2);
    await tickets.update(s.admin.actor, a!.id, a!.version, { priority: 'HIGH' });
    const fresh = await prisma.ticket.findUniqueOrThrow({ where: { id: a!.id } });
    await expect(tickets.bulkSetPriority(s.admin.actor, { items: s.pairs([fresh, b!]), priority: 'HIGH' })).rejects.toBeInstanceOf(BulkRejectedError);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: b!.id } })).priority).toBe('NORMAL');
  });
});

describe('bulkAssignState', () => {
  it('lists the selected tickets, the usable groups, their active members and the shared group', async () => {
    const s = await scenario();
    const batch = await s.make(2);
    const state = await queries.bulkAssignState(s.admin.actor, batch.map((t) => t.id));
    expect(state.tickets.map((t) => t.number).sort()).toEqual(batch.map((t) => t.number).sort());
    expect(state.sharedGroupId).toBe(s.groupA.id);
    expect(state.agentsByGroup[s.groupA.id]?.map((a) => a.id)).toContain(s.agentA.agent.id);
    expect(state.agentsByGroup[s.groupA.id]?.map((a) => a.id)).not.toContain(s.agentB.agent.id);
  });

  it('shows an agent only their own groups and counts out-of-scope tickets as unavailable', async () => {
    const s = await scenario();
    const batch = await s.make(1);
    const state = await queries.bulkAssignState(s.agentB.actor, batch.map((t) => t.id));
    expect(state.tickets).toHaveLength(0);
    expect(state.unavailable).toBe(1);
    expect(state.groups.map((g) => g.id)).toEqual([s.groupB.id]);
  });
});

describe('dashboard', () => {
  it('counts the open tickets of the agent and lists them in their queue', async () => {
    const s = await scenario();
    const batch = await s.make(3);
    await tickets.bulkAssign(s.admin.actor, { items: s.pairs(batch), assignedAgentId: s.agentA.agent.id });
    const data = await queries.dashboard(s.agentA.actor);
    expect(data.mineOpen).toBe(3);
    expect(data.open).toBeGreaterThanOrEqual(3);
    expect(data.open).toBeLessThanOrEqual(data.total);
    expect(data.queue.map((t) => t.id).sort()).toEqual(batch.map((t) => t.id).sort());
    expect(data.createdToday).toBeGreaterThanOrEqual(3);
    expect(data.incoming).toHaveLength(14);
    expect(data.incoming.reduce((sum, d) => sum + d.count, 0)).toBeGreaterThanOrEqual(3);
    const group = data.byGroup.find((g) => g.id === s.groupA.id);
    expect(group?.count).toBe(3);
    expect(group?.statuses).toEqual([{ code: 'NEW', name: expect.any(String), count: 3 }]);
    const mine = data.byAgent.find((a) => a.id === s.agentA.agent.id);
    expect(mine?.count).toBe(3);
    expect(mine?.statuses).toEqual([{ code: 'NEW', name: expect.any(String), count: 3 }]);
  });

  it('keeps the numbers inside the scope of the viewer', async () => {
    const s = await scenario();
    await s.make(2);
    const data = await queries.dashboard(s.agentB.actor);
    expect(data.byGroup.find((g) => g.id === s.groupA.id)).toBeUndefined();
  });
});

describe('suggestGroup and the activity feed', () => {
  it('suggests the group of the latest ticket of the customer, only if the viewer may use it', async () => {
    const s = await scenario();
    await s.make(1);
    expect(await queries.suggestGroup(s.admin.actor, s.customer.id)).toBe(s.groupA.id);
    expect(await queries.suggestGroup(s.agentB.actor, s.customer.id)).toBeNull();
    expect(await queries.suggestGroup(s.admin.actor, 'not-a-uuid')).toBeNull();
  });

  it('returns every history entry and every comment, so they can be merged into one feed', async () => {
    const s = await scenario();
    const [ticket] = await s.make(1);
    await tickets.assign(s.admin.actor, ticket!.id, ticket!.version, { assignedAgentId: s.agentA.agent.id });
    for (let i = 0; i < 12; i++) await comments.add(s.admin.actor, ticket!.id, { body: `comment ${i}` });
    const thread = await commentQueries.listAll(s.admin.actor, ticket!.id);
    expect(thread.items).toHaveLength(12);
    expect(thread.items[0]?.body).toBe('comment 0');
    const events = await queries.historyAll(s.admin.actor, ticket!.id);
    expect(events.map((e) => e.kind)).toEqual(['CREATED', 'ASSIGNED']);
  });
});
