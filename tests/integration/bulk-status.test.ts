import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BulkRejectedError, DomainError } from '../../src/domain/errors.js';
import { TicketService } from '../../src/domain/tickets/ticket-service.js';
import { Fixtures } from './helpers/fixtures.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for integration tests (see .env.example)');

const prisma = new PrismaClient();
const fx = new Fixtures(prisma);
const tickets = new TicketService(prisma);

const REASON = 'Picked up from the shared queue';
const UNRESOLVED_REASON = 'The vendor confirmed there is no fix';

beforeAll(async () => {
  await fx.init();
});

afterAll(async () => {
  await fx.cleanup();
  await prisma.$disconnect();
});

async function rejected(promise: Promise<unknown>): Promise<BulkRejectedError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, 'expected the batch to be rejected').toBeInstanceOf(BulkRejectedError);
  return err as BulkRejectedError;
}

async function domainError(promise: Promise<unknown>): Promise<DomainError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  return err as DomainError;
}

/** A group with an admin and an agent, and a helper that creates NEW tickets already assigned to the agent. */
async function scenario() {
  const group = await fx.group();
  const customer = await fx.customer();
  const admin = await fx.admin();
  const agent = await fx.agent([group]);
  const make = async (count: number, groupId = group.id, assignee = agent.agent.id) => {
    const created = [];
    for (let i = 0; i < count; i++) {
      created.push(await tickets.create(admin.actor, { subject: `Bulk ticket ${i + 1}`, description: 'd', customerId: customer.id, groupId, assignedAgentId: assignee }));
    }
    return created;
  };
  const pairs = (list: Array<{ id: string; version: number }>) => list.map((t) => ({ id: t.id, version: t.version }));
  return { group, customer, admin, agent, make, pairs };
}

const state = async (id: string) => {
  const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id }, include: { status: true } });
  const history = await prisma.ticketHistory.findMany({ where: { ticketId: id, kind: 'STATUS_CHANGED' } });
  return { status: ticket.status.code, version: ticket.version, history };
};

describe('bulkChangeStatus', () => {
  it('changes every selected ticket, bumps versions and writes one history entry per ticket', async () => {
    const s = await scenario();
    const batch = await s.make(3);
    const result = await tickets.bulkChangeStatus(s.agent.actor, { items: s.pairs(batch), targetStatus: 'IN_PROGRESS', reason: REASON });
    expect(result.changed.map((c) => c.status)).toEqual(['IN_PROGRESS', 'IN_PROGRESS', 'IN_PROGRESS']);
    for (const t of batch) {
      const after = await state(t.id);
      expect(after.status).toBe('IN_PROGRESS');
      expect(after.version).toBe(t.version + 1);
      expect(after.history).toHaveLength(1);
      expect(after.history[0]!.reason).toBe(REASON);
      expect(after.history[0]!.actorUserId).toBe(s.agent.user.id);
    }
  });

  it('is all or nothing: one stale ticket rolls back the others, with no history left behind', async () => {
    const s = await scenario();
    const [a, b, c] = await s.make(3);
    await tickets.update(s.admin.actor, b!.id, b!.version, { priority: 'HIGH' }); // someone edits b after the operator saw it

    const err = await rejected(tickets.bulkChangeStatus(s.agent.actor, { items: s.pairs([a!, b!, c!]), targetStatus: 'IN_PROGRESS' }));
    expect(err.status).toBe(409);
    expect(err.failures).toHaveLength(1);
    expect(err.failures[0]).toMatchObject({ ticketId: b!.id, number: b!.number, code: 'version_conflict' });
    expect(err.details).toHaveProperty(`Ticket #${b!.number}`);

    for (const t of [a!, c!]) {
      const after = await state(t.id);
      expect(after.status).toBe('NEW');
      expect(after.version).toBe(t.version);
      expect(after.history).toHaveLength(0);
    }
  });

  it('reports every refused ticket at once, and an out-of-scope ticket looks like an unknown one', async () => {
    const s = await scenario();
    const otherGroup = await fx.group();
    const otherAgent = await fx.agent([otherGroup]);
    const [ok, stale, started] = await s.make(3);
    const [foreign] = await s.make(1, otherGroup.id, otherAgent.agent.id);
    await tickets.update(s.admin.actor, stale!.id, stale!.version, { priority: 'HIGH' });
    const begun = await tickets.changeStatus(s.admin.actor, started!.id, started!.version, { targetStatus: 'IN_PROGRESS' }); // already there
    const unknown = '00000000-0000-4000-8000-000000000000';

    const err = await rejected(
      tickets.bulkChangeStatus(s.agent.actor, {
        items: [...s.pairs([ok!, stale!]), { id: begun.id, version: begun.version }, { id: foreign!.id, version: foreign!.version }, { id: unknown, version: 1 }],
        targetStatus: 'IN_PROGRESS',
      }),
    );
    const byId = new Map(err.failures.map((f) => [f.ticketId, f]));
    expect(err.failures).toHaveLength(4);
    expect(byId.get(stale!.id)).toMatchObject({ code: 'version_conflict', number: stale!.number });
    expect(byId.get(begun.id)).toMatchObject({ code: 'invalid_transition', number: begun.number });
    // Same answer, and no ticket number, for a ticket in another group and for one that does not exist.
    expect(byId.get(foreign!.id)).toMatchObject({ code: 'not_found', number: null, message: byId.get(unknown)!.message });
    expect(byId.get(unknown)).toMatchObject({ code: 'not_found', number: null });
    expect((await state(ok!.id)).status).toBe('NEW'); // the valid one was rolled back too
    expect((await state(foreign!.id)).status).toBe('NEW');
  });

  it('refuses more than 100 tickets before touching the database', async () => {
    const s = await scenario();
    const spy = vi.spyOn(prisma, '$transaction');
    try {
      const items = Array.from({ length: 101 }, () => ({ id: crypto.randomUUID(), version: 1 }));
      const err = await domainError(tickets.bulkChangeStatus(s.agent.actor, { items, targetStatus: 'IN_PROGRESS' }));
      expect(err).toMatchObject({ code: 'batch_too_large', status: 422 });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('validates the shape: empty selection, unknown fields and a ticket listed twice with different versions', async () => {
    const s = await scenario();
    const [t] = await s.make(1);
    const base = { items: s.pairs([t!]), targetStatus: 'IN_PROGRESS' };
    expect((await domainError(tickets.bulkChangeStatus(s.agent.actor, { ...base, items: [] }))).code).toBe('validation');
    expect((await domainError(tickets.bulkChangeStatus(s.agent.actor, { ...base, groupId: s.group.id }))).code).toBe('validation'); // no reassignment in bulk
    expect((await domainError(tickets.bulkChangeStatus(s.agent.actor, { ...base, items: [{ id: t!.id, version: 1 }, { id: t!.id, version: 2 }] }))).code).toBe('validation');
    expect((await state(t!.id)).status).toBe('NEW');
  });

  it('treats a repeated id with the same version as one ticket', async () => {
    const s = await scenario();
    const [t] = await s.make(1);
    const result = await tickets.bulkChangeStatus(s.agent.actor, { items: [...s.pairs([t!]), ...s.pairs([t!])], targetStatus: 'IN_PROGRESS' });
    expect(result.changed).toHaveLength(1);
    expect((await state(t!.id)).version).toBe(t!.version + 1);
  });

  it('applies the shared UNRESOLVED reason only after the operator confirms it', async () => {
    const s = await scenario();
    const batch = await s.make(2);
    await tickets.bulkChangeStatus(s.agent.actor, { items: s.pairs(batch), targetStatus: 'IN_PROGRESS' });
    const working = await Promise.all(batch.map((t) => prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })));

    const refused = await domainError(tickets.bulkChangeStatus(s.agent.actor, { items: s.pairs(working), targetStatus: 'UNRESOLVED', unresolvedReason: UNRESOLVED_REASON }));
    expect(refused.details).toHaveProperty('confirmSharedReason');
    expect((await state(working[0]!.id)).status).toBe('IN_PROGRESS');

    await tickets.bulkChangeStatus(s.agent.actor, { items: s.pairs(working), targetStatus: 'UNRESOLVED', unresolvedReason: UNRESOLVED_REASON, confirmSharedReason: true });
    for (const t of working) {
      const row = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id }, include: { status: true } });
      expect(row.status.code).toBe('UNRESOLVED');
      expect(row.unresolvedReason).toBe(UNRESOLVED_REASON);
    }
  });

  it('keeps ADMIN-only transitions admin-only, one by one', async () => {
    const s = await scenario();
    const [t] = await s.make(1);
    const working = await tickets.changeStatus(s.admin.actor, t!.id, t!.version, { targetStatus: 'IN_PROGRESS' });
    const solved = await tickets.changeStatus(s.admin.actor, working.id, working.version, { targetStatus: 'RESOLVED', resolution: 'Restarted the sync job and verified' });

    const asAgent = await rejected(tickets.bulkChangeStatus(s.agent.actor, { items: s.pairs([solved]), targetStatus: 'CLOSED' }));
    expect(asAgent.failures[0]).toMatchObject({ code: 'admin_only', number: solved.number });
    expect((await state(solved.id)).status).toBe('RESOLVED');

    await tickets.bulkChangeStatus(s.admin.actor, { items: s.pairs([solved]), targetStatus: 'CLOSED' });
    expect((await state(solved.id)).status).toBe('CLOSED');
  });

  it('lets two overlapping batches race without a deadlock: one wins, the other is rejected cleanly', async () => {
    const s = await scenario();
    for (let round = 0; round < 5; round++) {
      // Fresh tickets each round: deadlocks are timing dependent, so one round could pass by luck.
      const batch = await s.make(8);
      const forward = s.pairs(batch);
      const backward = [...forward].reverse();
      const results = await Promise.allSettled([
        tickets.bulkChangeStatus(s.agent.actor, { items: forward, targetStatus: 'IN_PROGRESS' }),
        tickets.bulkChangeStatus(s.admin.actor, { items: backward, targetStatus: 'IN_PROGRESS' }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(lost.reason).toBeInstanceOf(BulkRejectedError);
      for (const t of batch) expect((await state(t.id)).version).toBe(t.version + 1); // changed exactly once
    }
  }, 60_000);

  it('handles a full batch of 100 tickets in one transaction', async () => {
    const s = await scenario();
    const batch = await s.make(100);
    const started = Date.now();
    const result = await tickets.bulkChangeStatus(s.agent.actor, { items: s.pairs(batch), targetStatus: 'IN_PROGRESS', reason: REASON });
    const elapsed = Date.now() - started;
    expect(result.changed).toHaveLength(100);
    expect(await prisma.ticketHistory.count({ where: { ticketId: { in: batch.map((t) => t.id) }, kind: 'STATUS_CHANGED' } })).toBe(100);
    console.info(`bulkChangeStatus(100 tickets): ${elapsed} ms`);
    expect(elapsed).toBeLessThan(20_000);
  }, 120_000);
});
