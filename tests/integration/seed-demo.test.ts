import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyPassword } from '../../src/auth/password.js';
import { SeedGuardError } from '../../src/seed/config.js';
import { SIZES } from '../../src/seed/dataset.js';
import { ownedIds } from '../../src/seed/owned.js';
import { planReset, resetDemo } from '../../src/seed/reset.js';
import { seedDemo } from '../../src/seed/seed.js';
import { verifyDemo } from '../../src/seed/verify.js';
import { MemoryStorage } from '../../src/storage/memory-storage.js';
import { Fixtures } from './helpers/fixtures.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for integration tests (see .env.example)');

// A dataset of its own: its ids, e-mail addresses and group codes cannot collide with the real demo data
// or with other test files, and everything it creates is removed again in afterAll.
const dataset = `seedtest-${randomUUID().slice(0, 8)}`;
const REF = new Date('2026-10-11T06:00:00Z');
const ADMIN_PASSWORD = 'Demo-admin-secret-1';
const AGENT_PASSWORD = 'Demo-agent-secret-1';
const env = { APP_ENV: 'development', ALLOW_DEMO_RESET: 'true', SEED_ADMIN_PASSWORD: ADMIN_PASSWORD, SEED_AGENT_PASSWORD: AGENT_PASSWORD };
const options = { dataset, seed: 42, referenceDate: REF, concurrency: 8 };

const prisma = new PrismaClient();
const fx = new Fixtures(prisma);
const storage = new MemoryStorage();
const ids = ownedIds(dataset);

const rows = async () => ({
  users: await prisma.user.count({ where: { id: { in: ids.userIds } } }),
  tickets: await prisma.ticket.count({ where: { id: { in: ids.ticketIds } } }),
  comments: await prisma.comment.count({ where: { ticketId: { in: ids.ticketIds } } }),
  attachments: await prisma.attachment.count({ where: { comment: { ticketId: { in: ids.ticketIds } } } }),
});

async function failure(promise: Promise<unknown>): Promise<Error> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  return err as Error;
}

beforeAll(async () => {
  await fx.init();
});

afterAll(async () => {
  await resetDemo(prisma, storage, env, { dataset, confirm: dataset }, { ...options, deleteOnly: true }).catch(() => undefined);
  await fx.cleanup();
  await prisma.$disconnect();
});

describe('seed:demo', () => {
  let first: Record<string, number>;

  it('creates the whole dataset, with every attachment really stored', async () => {
    first = await seedDemo(prisma, storage, env, options);
    expect(first).toMatchObject({ users: 17, agents: 15, groups: 5, memberships: 25, customers: 300, tickets: 2000, comments: 10000, attachments: 200, 'files uploaded': 200 });
    expect(first.history).toBeGreaterThan(2000);
    expect(storage.count).toBe(SIZES.attachments);
    const row = await prisma.attachment.findFirstOrThrow({ where: { comment: { ticketId: { in: ids.ticketIds } } } });
    expect(row).toMatchObject({ state: 'READY', bucket: storage.bucket });
    expect(storage.get(row.objectKey)?.length).toBe(row.sizeBytes);
  }, 180_000);

  it('does nothing the second time: no duplicates, no uploads', async () => {
    const again = await seedDemo(prisma, storage, env, options);
    expect(Object.values(again).every((n) => n === 0)).toBe(true);
    expect(await rows()).toEqual({ users: 17, tickets: 2000, comments: 10000, attachments: 200 });
    expect(storage.count).toBe(SIZES.attachments);
  }, 180_000);

  it('passes seed:verify, with every file present in Storage', async () => {
    const result = await verifyDemo(prisma, storage, { dataset });
    expect(result.problems).toEqual([]);
    expect(result.filesChecked).toBe(SIZES.attachments);
  }, 120_000);

  it('hashes the passwords from the environment and changes them only on request', async () => {
    const admin = await prisma.user.findFirstOrThrow({ where: { id: { in: ids.userIds }, role: 'ADMIN' } });
    const agent = await prisma.user.findFirstOrThrow({ where: { id: { in: ids.userIds }, role: 'AGENT' } });
    expect(admin.passwordHash).not.toContain(ADMIN_PASSWORD);
    expect(await verifyPassword(admin.passwordHash, ADMIN_PASSWORD)).toBe(true);
    expect(await verifyPassword(agent.passwordHash, AGENT_PASSWORD)).toBe(true);
    expect(await verifyPassword(agent.passwordHash, ADMIN_PASSWORD)).toBe(false);

    const rotated = { ...env, SEED_ADMIN_PASSWORD: 'Rotated-admin-secret-2', SEED_AGENT_PASSWORD: 'Rotated-agent-secret-2' };
    await seedDemo(prisma, storage, rotated, options); // no --rotate-demo-passwords: nothing changes
    expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).passwordHash).toBe(admin.passwordHash);

    const summary = await seedDemo(prisma, storage, rotated, { ...options, rotatePasswords: true });
    expect(summary['passwords rotated']).toBe(17);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(await verifyPassword(after.passwordHash, 'Rotated-admin-secret-2')).toBe(true);
    expect(after.sessionVersion).toBe(admin.sessionVersion + 1); // old sessions end
  }, 120_000);

  it('refuses to run in production or in the test environment, and without passwords when accounts are missing', async () => {
    expect((await failure(seedDemo(prisma, storage, { ...env, APP_ENV: 'production' }, options))).message).toMatch(/production/);
    expect((await failure(seedDemo(prisma, storage, { ...env, APP_ENV: 'test' }, options))).message).toMatch(/APP_ENV=test/);
    const empty = { dataset: `seedtest-${randomUUID().slice(0, 8)}` };
    const err = await failure(seedDemo(prisma, new MemoryStorage(), { APP_ENV: 'development' }, empty));
    expect(err).toBeInstanceOf(SeedGuardError);
    expect(err.message).toMatch(/SEED_ADMIN_PASSWORD/);
    expect(await prisma.user.count({ where: { normalizedEmail: { contains: empty.dataset } } })).toBe(0); // nothing was written
  });

  it('refuses addresses that belong to somebody else, before writing anything', async () => {
    const other = `seedtest-${randomUUID().slice(0, 8)}`;
    const squatter = await prisma.user.create({ data: { normalizedEmail: `admin1.${other}@example.test`, displayName: 'Squatter', passwordHash: 'x', role: 'ADMIN' } });
    try {
      const err = await failure(seedDemo(prisma, new MemoryStorage(), env, { dataset: other }));
      expect(err.message).toMatch(/not part of the demo dataset/);
      expect(await prisma.user.count({ where: { normalizedEmail: { contains: other } } })).toBe(1); // only the squatter
    } finally {
      await prisma.user.delete({ where: { id: squatter.id } });
    }
  });
});

describe('seed:verify', () => {
  it('notices a file that is gone from Storage, a changed ticket and an extra comment, and seed:demo repairs the file', async () => {
    const row = await prisma.attachment.findFirstOrThrow({ where: { comment: { ticketId: { in: ids.ticketIds } } } });
    await storage.delete(row.objectKey);
    const ticket = await prisma.ticket.findFirstOrThrow({ where: { id: { in: ids.ticketIds }, status: { code: 'NEW' } } });
    const closed = await prisma.ticketStatus.findUniqueOrThrow({ where: { code: 'CLOSED' } });
    await prisma.ticket.update({ where: { id: ticket.id }, data: { statusId: closed.id } });

    const broken = await verifyDemo(prisma, storage, { dataset });
    const text = broken.problems.join('\n');
    expect(text).toMatch(/is missing from Storage/);
    expect(text).toMatch(/tickets NEW is 499/);
    expect(text).toMatch(/history ends in NEW, the ticket is CLOSED/);

    const newStatus = await prisma.ticketStatus.findUniqueOrThrow({ where: { code: 'NEW' } });
    await prisma.ticket.update({ where: { id: ticket.id }, data: { statusId: newStatus.id } });
    const repaired = await seedDemo(prisma, storage, env, options);
    expect(repaired['files uploaded']).toBe(1);
    expect((await verifyDemo(prisma, storage, { dataset })).problems).toEqual([]);
  }, 180_000);
});

describe('seed:reset', () => {
  const args = { dataset, confirm: dataset };

  it('wants the right environment, the explicit switch and the dataset name typed twice', async () => {
    expect((await failure(resetDemo(prisma, storage, { ...env, APP_ENV: 'production' }, args, options))).message).toMatch(/production/);
    expect((await failure(resetDemo(prisma, storage, { ...env, APP_ENV: 'test' }, args, options))).message).toMatch(/APP_ENV=test/);
    expect((await failure(resetDemo(prisma, storage, { ...env, APP_ENV: undefined }, args, options))).message).toMatch(/APP_ENV=development or APP_ENV=demo explicitly/);
    expect((await failure(resetDemo(prisma, storage, { ...env, ALLOW_DEMO_RESET: undefined }, args, options))).message).toMatch(/ALLOW_DEMO_RESET/);
    expect((await failure(resetDemo(prisma, storage, env, { dataset, confirm: 'nope' }, options))).message).toMatch(/--confirm/);
    expect((await failure(resetDemo(prisma, storage, env, { dataset: 'other', confirm: 'other' }, options))).message).toMatch(/--dataset/);
    expect(await rows()).toEqual({ users: 17, tickets: 2000, comments: 10000, attachments: 200 });
  });

  it('needs the account passwords up front when it is going to recreate, so it never deletes and then fails', async () => {
    const err = await failure(resetDemo(prisma, storage, { ...env, SEED_ADMIN_PASSWORD: undefined }, args, options));
    expect(err.message).toMatch(/--delete-only/);
    expect((await rows()).tickets).toBe(2000);
  });

  it('hands over the counts before it deletes anything, not afterwards', async () => {
    let planned: Record<string, number> | undefined;
    let before: Awaited<ReturnType<typeof rows>> | undefined;
    await resetDemo(prisma, storage, env, args, {
      ...options,
      deleteOnly: true,
      onPlan: async (plan) => {
        planned = plan.rows;
        before = await rows(); // asked from inside the callback: nothing has been deleted yet
      },
    });
    expect(planned).toMatchObject({ users: 17, tickets: 2000, comments: 10000, attachments: 200 });
    expect(before).toEqual({ users: 17, tickets: 2000, comments: 10000, attachments: 200 });
    expect(await rows()).toEqual({ users: 0, tickets: 0, comments: 0, attachments: 0 }); // and then it went through
    await seedDemo(prisma, storage, env, options); // put the dataset back for the tests that follow
  }, 300_000);

  it('removes the files of rows in every state, not only READY ones', async () => {
    const comment = await prisma.comment.findFirstOrThrow({ where: { ticketId: { in: ids.ticketIds } } });
    const user = await prisma.user.findFirstOrThrow({ where: { id: { in: ids.userIds } } });
    const leftovers = (['PENDING', 'FAILED', 'DELETING'] as const).map((state, i) => ({ state, key: `tickets/${comment.ticketId}/comments/${comment.id}/state-${i}` }));
    for (const { state, key } of leftovers) {
      await storage.put(key, Buffer.from(state), 'text/plain');
      await prisma.attachment.create({
        data: { commentId: comment.id, bucket: storage.bucket, objectKey: key, originalName: `${state}.txt`, contentType: 'text/plain', sizeBytes: state.length, sha256: 'b'.repeat(64), state, createdByUserId: user.id },
      });
    }
    const plan = await planReset(prisma, dataset);
    expect(plan.rows.attachments).toBe(203);
    expect(leftovers.every(({ key }) => plan.keys.includes(key))).toBe(true);
    await prisma.attachment.deleteMany({ where: { objectKey: { in: leftovers.map((l) => l.key) } } });
    await Promise.all(leftovers.map((l) => storage.delete(l.key)));
  });

  it('shows what it would delete on a dry run, and deletes nothing', async () => {
    const result = await resetDemo(prisma, storage, env, args, { ...options, dryRun: true });
    expect(result.deleted).toBe(false);
    expect(result.plan.rows).toMatchObject({ users: 17, tickets: 2000, comments: 10000, attachments: 200 });
    expect(result.plan.objects).toBe(200);
    expect(await rows()).toEqual({ users: 17, tickets: 2000, comments: 10000, attachments: 200 });
    expect(storage.count).toBe(200);
  });

  it('deletes nothing when other records still depend on the demo data', async () => {
    const group = await prisma.supportGroup.findFirstOrThrow({ where: { id: { in: ids.groupIds } } });
    const customer = await fx.customer();
    const admin = await fx.admin();
    const status = await prisma.ticketStatus.findUniqueOrThrow({ where: { code: 'NEW' } });
    const foreign = await prisma.ticket.create({ data: { subject: 'Created by a reviewer', description: 'd', customerId: customer.id, groupId: group.id, statusId: status.id, createdByUserId: admin.user.id } });
    try {
      const err = await failure(resetDemo(prisma, storage, env, args, options));
      expect(err).toBeInstanceOf(SeedGuardError);
      expect(err.message).toMatch(/Nothing was deleted/);
      expect(await rows()).toEqual({ users: 17, tickets: 2000, comments: 10000, attachments: 200 }); // the transaction rolled back
      expect(storage.count).toBe(200); // and no file was touched
    } finally {
      await prisma.ticket.delete({ where: { id: foreign.id } });
    }
  }, 180_000);

  it('removes only the dataset, its files and nothing else, then recreates it', async () => {
    const bystander = await fx.customer();
    const keep = new MemoryStorage();
    void keep;
    await storage.put('tickets/not-ours/comments/x/file', Buffer.from('keep me'), 'text/plain');
    const before = await planReset(prisma, dataset);

    const result = await resetDemo(prisma, storage, env, args, options);
    expect(result.deleted).toBe(true);
    expect(result.plan.rows.tickets).toBe(2000);
    expect(result.plan.objects).toBe(before.objects);
    expect(result.seeded).toMatchObject({ tickets: 2000, comments: 10000, attachments: 200, 'files uploaded': 200 });

    expect(storage.has('tickets/not-ours/comments/x/file')).toBe(true); // a file that is not the dataset's stays
    expect(await prisma.customer.count({ where: { id: bystander.id } })).toBe(1); // so does every other row
    expect(await rows()).toEqual({ users: 17, tickets: 2000, comments: 10000, attachments: 200 });
    expect(storage.count).toBe(201);
    expect((await verifyDemo(prisma, storage, { dataset })).problems).toEqual([]);
  }, 300_000);

  it('can delete without recreating', async () => {
    const result = await resetDemo(prisma, storage, env, args, { ...options, deleteOnly: true });
    expect(result.seeded).toBeUndefined();
    expect(await rows()).toEqual({ users: 0, tickets: 0, comments: 0, attachments: 0 });
    expect(storage.count).toBe(1); // only the file that is not the dataset's
    expect(await prisma.supportGroup.count({ where: { id: { in: ids.groupIds } } })).toBe(0);
  }, 300_000);
});
