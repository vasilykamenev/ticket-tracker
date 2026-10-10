import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommentQueries } from '../../src/domain/comments/comment-queries.js';
import { CommentService } from '../../src/domain/comments/comment-service.js';
import { DomainError } from '../../src/domain/errors.js';
import { TicketService } from '../../src/domain/tickets/ticket-service.js';
import { Fixtures } from './helpers/fixtures.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for integration tests (see .env.example)');

const prisma = new PrismaClient();
const fx = new Fixtures(prisma);
const tickets = new TicketService(prisma);
const comments = new CommentService(prisma);
const queries = new CommentQueries(prisma);

const RESOLUTION = 'Restarted the sync job and verified';

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

/** Two groups; an ADMIN, two agents in group A, an agent in group B; an in-progress ticket in A. */
async function scenario() {
  const groupA = await fx.group();
  const groupB = await fx.group();
  const customer = await fx.customer();
  const admin = await fx.admin();
  const author = await fx.agent([groupA]);
  const colleague = await fx.agent([groupA]);
  const outsider = await fx.agent([groupB]);
  const base = { description: 'Details', customerId: customer.id };
  const created = await tickets.create(admin.actor, { ...base, subject: 'Printer offline', groupId: groupA.id, assignedAgentId: author.agent.id });
  const ticket = await tickets.changeStatus(admin.actor, created.id, created.version, { targetStatus: 'IN_PROGRESS' });
  const foreign = await tickets.create(admin.actor, { ...base, subject: 'Invoice mismatch', groupId: groupB.id });
  return { groupA, groupB, admin, author, colleague, outsider, ticket, foreign };
}

type Scenario = Awaited<ReturnType<typeof scenario>>;

/** Walks an in-progress ticket to CLOSED (via RESOLVED) or UNRESOLVED. */
async function freeze(s: Scenario, target: 'CLOSED' | 'UNRESOLVED') {
  let t = s.ticket;
  if (target === 'UNRESOLVED') {
    return tickets.changeStatus(s.admin.actor, t.id, t.version, { targetStatus: 'UNRESOLVED', unresolvedReason: 'Vendor limitation, no fix' });
  }
  t = await tickets.changeStatus(s.admin.actor, t.id, t.version, { targetStatus: 'RESOLVED', resolution: RESOLUTION });
  return tickets.changeStatus(s.admin.actor, t.id, t.version, { targetStatus: 'CLOSED' });
}

describe('adding', () => {
  it('stores the comment with the author from the actor and the ticket from the URL, trimmed', async () => {
    const s = await scenario();
    const c = await comments.add(s.author.actor, s.ticket.id, { body: '  Asked the customer for logs.\nWaiting.  ' });
    expect(c).toMatchObject({ ticketId: s.ticket.id, authorUserId: s.author.user.id, body: 'Asked the customer for logs.\nWaiting.', version: 1 });
  });

  it('keeps markup as plain text (escaping happens at render time)', async () => {
    const s = await scenario();
    const c = await comments.add(s.admin.actor, s.ticket.id, { body: '<img src=x onerror=alert(1)> & <b>bold</b>' });
    expect(c.body).toBe('<img src=x onerror=alert(1)> & <b>bold</b>');
  });

  it('moves the ticket up the recently-updated list without touching its version', async () => {
    const s = await scenario();
    const before = await prisma.ticket.findUniqueOrThrow({ where: { id: s.ticket.id } });
    await new Promise((r) => setTimeout(r, 20));
    await comments.add(s.author.actor, s.ticket.id, { body: 'Activity' });
    const after = await prisma.ticket.findUniqueOrThrow({ where: { id: s.ticket.id } });
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    expect(after.version).toBe(before.version); // an open ticket edit must not become stale because of a comment
  });

  it('rejects empty, whitespace-only and over-long bodies', async () => {
    const s = await scenario();
    for (const body of ['', '   \n  ', 'x'.repeat(5001)]) {
      expect((await failure(comments.add(s.author.actor, s.ticket.id, { body }))).code, `length ${body.length}`).toBe('validation');
    }
    await expect(comments.add(s.author.actor, s.ticket.id, { body: 'x'.repeat(5000) })).resolves.toBeTruthy();
  });

  it('ignores nothing: ticket, author, version and unknown fields in the payload are rejected', async () => {
    const s = await scenario();
    for (const extra of [{ ticketId: s.foreign.id }, { authorUserId: s.admin.user.id }, { version: 9 }, { createdAt: '2020-01-01' }]) {
      expect((await failure(comments.add(s.author.actor, s.ticket.id, { body: 'ok', ...extra }))).code, JSON.stringify(extra)).toBe('validation');
    }
    expect(await prisma.comment.count({ where: { ticketId: s.ticket.id } })).toBe(0);
  });

  it('hides tickets outside the scope as 404 and refuses malformed ids', async () => {
    const s = await scenario();
    expect((await failure(comments.add(s.author.actor, s.foreign.id, { body: 'Not mine' }))).status).toBe(404);
    expect((await failure(comments.add(s.author.actor, 'nope', { body: 'x' }))).status).toBe(404);
    expect((await failure(comments.add(s.author.actor, '00000000-0000-4000-8000-000000000000', { body: 'x' }))).status).toBe(404);
    expect(await prisma.comment.count({ where: { ticketId: s.foreign.id } })).toBe(0);
  });

  it('is allowed on RESOLVED tickets, but not on CLOSED or UNRESOLVED ones', async () => {
    const s = await scenario();
    const resolved = await tickets.changeStatus(s.admin.actor, s.ticket.id, s.ticket.version, { targetStatus: 'RESOLVED', resolution: RESOLUTION });
    await expect(comments.add(s.author.actor, resolved.id, { body: 'Customer confirmed' })).resolves.toBeTruthy();

    const closed = await tickets.changeStatus(s.admin.actor, resolved.id, resolved.version, { targetStatus: 'CLOSED' });
    for (const actor of [s.admin.actor, s.author.actor]) {
      expect((await failure(comments.add(actor, closed.id, { body: 'Too late' }))).code).toBe('ticket_frozen');
    }

    const t2 = await scenario();
    const unresolved = await freeze(t2, 'UNRESOLVED');
    expect((await failure(comments.add(t2.admin.actor, unresolved.id, { body: 'Nope' }))).code).toBe('ticket_frozen');
  });

  it('works again once the ticket is reopened', async () => {
    const s = await scenario();
    const unresolved = await freeze(s, 'UNRESOLVED');
    expect((await failure(comments.add(s.admin.actor, unresolved.id, { body: 'Nope' }))).code).toBe('ticket_frozen');
    const reopened = await tickets.changeStatus(s.admin.actor, unresolved.id, unresolved.version, { targetStatus: 'IN_PROGRESS', reason: 'Vendor shipped a fix' });
    await expect(comments.add(s.admin.actor, reopened.id, { body: 'Back at it' })).resolves.toBeTruthy();
  });
});

describe('editing', () => {
  it('lets the author edit and bumps the comment version', async () => {
    const s = await scenario();
    const c = await comments.add(s.author.actor, s.ticket.id, { body: 'First draft' });
    const edited = await comments.edit(s.author.actor, c.id, c.version, { body: 'Second draft' });
    expect(edited).toMatchObject({ body: 'Second draft', version: 2, authorUserId: s.author.user.id });
    expect(edited.updatedAt.getTime()).toBeGreaterThanOrEqual(c.updatedAt.getTime());
  });

  it('lets ADMIN edit anyone\'s comment, but an AGENT only their own', async () => {
    const s = await scenario();
    const c = await comments.add(s.author.actor, s.ticket.id, { body: 'By the author' });
    const byAdmin = await comments.edit(s.admin.actor, c.id, c.version, { body: 'Corrected by an administrator' });
    expect(byAdmin.authorUserId).toBe(s.author.user.id); // the author does not change

    const err = await failure(comments.edit(s.colleague.actor, c.id, byAdmin.version, { body: 'Hijacked' }));
    expect(err.code).toBe('not_author');
    expect(err.status).toBe(403);
    expect((await prisma.comment.findUniqueOrThrow({ where: { id: c.id } })).body).toBe('Corrected by an administrator');
  });

  it('detects concurrent edits through the comment version', async () => {
    const s = await scenario();
    const c = await comments.add(s.author.actor, s.ticket.id, { body: 'Original' });
    await comments.edit(s.author.actor, c.id, c.version, { body: 'Edited once' });
    const stale = await failure(comments.edit(s.admin.actor, c.id, c.version, { body: 'Edited from a stale copy' }));
    expect(stale.code).toBe('version_conflict');
    expect(stale.status).toBe(409);
    expect((await prisma.comment.findUniqueOrThrow({ where: { id: c.id } })).body).toBe('Edited once');
  });

  it('lets exactly one of two simultaneous edits with the same version win', async () => {
    const s = await scenario();
    const c = await comments.add(s.author.actor, s.ticket.id, { body: 'Original' });
    const results = await Promise.allSettled([
      comments.edit(s.author.actor, c.id, c.version, { body: 'Edit A' }),
      comments.edit(s.admin.actor, c.id, c.version, { body: 'Edit B' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason as DomainError).code).toBe('version_conflict');
    expect((await prisma.comment.findUniqueOrThrow({ where: { id: c.id } })).version).toBe(2);
  });

  it('rejects a no-op edit, bad bodies and an unknown or foreign comment', async () => {
    const s = await scenario();
    const c = await comments.add(s.author.actor, s.ticket.id, { body: 'Same text' });
    expect((await failure(comments.edit(s.author.actor, c.id, c.version, { body: 'Same text' }))).code).toBe('no_change');
    expect((await failure(comments.edit(s.author.actor, c.id, c.version, { body: '  ' }))).code).toBe('validation');
    expect((await failure(comments.edit(s.author.actor, c.id, c.version, { body: 'x', ticketId: s.foreign.id }))).code).toBe('validation');
    expect((await failure(comments.edit(s.outsider.actor, c.id, c.version, { body: 'From another group' }))).status).toBe(404);
    expect((await failure(comments.edit(s.author.actor, 'nope', 1, { body: 'x' }))).status).toBe(404);
  });

  it('is refused for everyone on CLOSED and UNRESOLVED tickets, and works after reopening', async () => {
    const s = await scenario();
    const c = await comments.add(s.author.actor, s.ticket.id, { body: 'Written while open' });
    const unresolved = await freeze(s, 'UNRESOLVED');
    for (const actor of [s.admin.actor, s.author.actor]) {
      expect((await failure(comments.edit(actor, c.id, c.version, { body: 'Rewriting history' }))).code).toBe('ticket_frozen');
    }
    const reopened = await tickets.changeStatus(s.admin.actor, unresolved.id, unresolved.version, { targetStatus: 'IN_PROGRESS', reason: 'Vendor shipped a fix' });
    expect(reopened.status.code).toBe('IN_PROGRESS');
    await expect(comments.edit(s.author.actor, c.id, c.version, { body: 'Now it can change' })).resolves.toBeTruthy();
  });

  it('stays possible on a RESOLVED ticket', async () => {
    const s = await scenario();
    const c = await comments.add(s.author.actor, s.ticket.id, { body: 'Before resolving' });
    await tickets.changeStatus(s.admin.actor, s.ticket.id, s.ticket.version, { targetStatus: 'RESOLVED', resolution: RESOLUTION });
    await expect(comments.edit(s.author.actor, c.id, c.version, { body: 'Clarified after resolving' })).resolves.toBeTruthy();
  });
});

describe('a comment belongs to one ticket', () => {
  it('cannot be edited through another ticket', async () => {
    const s = await scenario();
    const other = await tickets.create(s.admin.actor, { subject: 'Another ticket', description: 'd', customerId: (await fx.customer()).id, groupId: s.groupA.id });
    const c = await comments.add(s.author.actor, s.ticket.id, { body: 'Belongs to the first ticket' });
    expect((await failure(comments.edit(s.author.actor, c.id, c.version, { body: 'Smuggled' }, other.id))).status).toBe(404);
    await expect(comments.edit(s.author.actor, c.id, c.version, { body: 'Through its own ticket' }, s.ticket.id)).resolves.toBeTruthy();
  });
});

describe('locking against a ticket that is being closed', () => {
  it('makes an add wait for the closing transaction and then refuse', async () => {
    const s = await scenario();
    const resolved = await tickets.changeStatus(s.admin.actor, s.ticket.id, s.ticket.version, { targetStatus: 'RESOLVED', resolution: RESOLUTION });
    const closedStatus = await prisma.ticketStatus.findUniqueOrThrow({ where: { code: 'CLOSED' } });

    let adding!: Promise<unknown>;
    await prisma.$transaction(async (tx) => {
      // The closing transaction has changed the row but not committed yet ...
      await tx.ticket.update({ where: { id: resolved.id }, data: { statusId: closedStatus.id } });
      adding = comments.add(s.author.actor, resolved.id, { body: 'Racing the close' }).then(
        () => 'added',
        (e: unknown) => e,
      );
      // ... so the comment must still be waiting for the lock, not slipping through.
      const early = await Promise.race([adding, new Promise((r) => setTimeout(() => r('waiting'), 500))]);
      expect(early).toBe('waiting');
    });

    const outcome = await adding;
    expect(outcome).toBeInstanceOf(DomainError);
    expect((outcome as DomainError).code).toBe('ticket_frozen');
    expect(await prisma.comment.count({ where: { ticketId: resolved.id } })).toBe(0);
  });

  it('does the same for an edit', async () => {
    const s = await scenario();
    const c = await comments.add(s.author.actor, s.ticket.id, { body: 'Before the close' });
    const resolved = await tickets.changeStatus(s.admin.actor, s.ticket.id, s.ticket.version, { targetStatus: 'RESOLVED', resolution: RESOLUTION });
    const closedStatus = await prisma.ticketStatus.findUniqueOrThrow({ where: { code: 'CLOSED' } });

    let editing!: Promise<unknown>;
    await prisma.$transaction(async (tx) => {
      await tx.ticket.update({ where: { id: resolved.id }, data: { statusId: closedStatus.id } });
      editing = comments.edit(s.author.actor, c.id, c.version, { body: 'Edit racing the close' }).then(
        () => 'edited',
        (e: unknown) => e,
      );
      expect(await Promise.race([editing, new Promise((r) => setTimeout(() => r('waiting'), 500))])).toBe('waiting');
    });
    expect(((await editing) as DomainError).code).toBe('ticket_frozen');
    expect((await prisma.comment.findUniqueOrThrow({ where: { id: c.id } })).body).toBe('Before the close');
  });
});

describe('listing', () => {
  it('pages oldest first and says what the viewer may do', async () => {
    const s = await scenario();
    for (let i = 1; i <= 12; i++) await comments.add(i % 2 ? s.author.actor : s.admin.actor, s.ticket.id, { body: `Comment ${i}` });

    const first = await queries.list(s.author.actor, s.ticket.id, 1);
    expect(first).toMatchObject({ total: 12, page: 1, perPage: 10, canAdd: true });
    expect(first.items.map((i) => i.body)).toEqual(Array.from({ length: 10 }, (_, i) => `Comment ${i + 1}`));
    const second = await queries.list(s.author.actor, s.ticket.id, 2);
    expect(second.items.map((i) => i.body)).toEqual(['Comment 11', 'Comment 12']);

    // the author may edit only their own (odd numbers); ADMIN edits all; the colleague none
    expect(first.items.filter((i) => i.canEdit).map((i) => i.body)).toEqual(['Comment 1', 'Comment 3', 'Comment 5', 'Comment 7', 'Comment 9']);
    expect((await queries.list(s.admin.actor, s.ticket.id, 1)).items.every((i) => i.canEdit)).toBe(true);
    expect((await queries.list(s.colleague.actor, s.ticket.id, 1)).items.some((i) => i.canEdit)).toBe(false);
    expect(first.items[0]).toMatchObject({ authorName: s.author.user.displayName, edited: false });
  });

  it('marks edited comments and withdraws every control from frozen tickets while keeping them readable', async () => {
    const s = await scenario();
    const c = await comments.add(s.author.actor, s.ticket.id, { body: 'Original' });
    await comments.edit(s.author.actor, c.id, c.version, { body: 'Changed' });
    const frozen = await freeze(s, 'UNRESOLVED');

    const view = await queries.list(s.admin.actor, frozen.id);
    expect(view.canAdd).toBe(false);
    expect(view.items).toHaveLength(1);
    expect(view.items[0]).toMatchObject({ body: 'Changed', edited: true, canEdit: false });
  });

  it('is unavailable for tickets outside the scope', async () => {
    const s = await scenario();
    expect((await failure(queries.list(s.author.actor, s.foreign.id))).status).toBe(404);
    expect((await failure(queries.list(s.author.actor, 'nope'))).status).toBe(404);
  });
});
