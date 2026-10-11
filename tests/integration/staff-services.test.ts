import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyPassword } from '../../src/auth/password.js';
import { DomainError } from '../../src/domain/errors.js';
import { TicketService } from '../../src/domain/tickets/ticket-service.js';
import { AgentService } from '../../src/domain/users/agent-service.js';
import { UserService } from '../../src/domain/users/user-service.js';
import { Fixtures } from './helpers/fixtures.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for integration tests (see .env.example)');

const prisma = new PrismaClient();
const fx = new Fixtures(prisma);
const users = new UserService(prisma);
const agents = new AgentService(prisma);
const tickets = new TicketService(prisma);

const PASSWORD = 'A-long-enough-passphrase';

async function failure(promise: Promise<unknown>): Promise<DomainError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, 'expected a DomainError').toBeInstanceOf(DomainError);
  return err as DomainError;
}

const restore: Array<() => Promise<unknown>> = [];

/**
 * The last-administrator rule needs a database in which the accounts under test are the only active
 * ADMINs. Other admins are switched off for the duration of `fn` and always switched back on.
 * (Use a throwaway database for tests.)
 */
async function onlyAdmins<T>(keep: string[], fn: () => Promise<T>): Promise<T> {
  const others = await prisma.user.findMany({ where: { role: 'ADMIN', isActive: true, id: { notIn: keep } }, select: { id: true } });
  const ids = others.map((o) => o.id);
  const reenable = () => prisma.user.updateMany({ where: { id: { in: ids } }, data: { isActive: true } });
  restore.push(reenable);
  await prisma.user.updateMany({ where: { id: { in: ids } }, data: { isActive: false } });
  try {
    return await fn();
  } finally {
    await reenable();
  }
}

let admin: Awaited<ReturnType<Fixtures['admin']>>;

async function created(input: { role: 'ADMIN' | 'AGENT'; name?: string }) {
  const user = await users.create(admin.actor, { email: fx.email('svc'), displayName: input.name ?? 'Service User', role: input.role, password: PASSWORD });
  fx.trackUser(user.id);
  return user;
}

beforeAll(async () => {
  await fx.init();
  admin = await fx.admin();
});

afterAll(async () => {
  for (const undo of restore) await undo();
  await fx.cleanup();
  await prisma.$disconnect();
});

describe('creating accounts', () => {
  it('creates an AGENT with an active support profile and an ADMIN without one', async () => {
    const agent = await created({ role: 'AGENT', name: 'Alex Agent' });
    const profile = await prisma.agent.findUnique({ where: { userId: agent.id } });
    expect(profile).toMatchObject({ displayName: 'Alex Agent', isActive: true });

    const boss = await created({ role: 'ADMIN' });
    expect(await prisma.agent.findUnique({ where: { userId: boss.id } })).toBeNull();
  });

  it('normalizes the email, stores an Argon2id hash and rejects weak passwords and duplicates', async () => {
    const email = fx.email('Mixed-Case').toUpperCase();
    const user = await users.create(admin.actor, { email: ` ${email} `, displayName: 'Case Test', role: 'AGENT', password: PASSWORD });
    fx.trackUser(user.id);
    expect(user.normalizedEmail).toBe(email.trim().toLowerCase());
    expect(user.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(user.passwordHash, PASSWORD)).toBe(true);

    expect((await failure(users.create(admin.actor, { email: fx.email('weak'), displayName: 'Weak', role: 'AGENT', password: 'short' }))).details).toHaveProperty('password');
    expect((await failure(users.create(admin.actor, { email, displayName: 'Dup', role: 'AGENT', password: PASSWORD }))).details).toHaveProperty('email');
  });

  it('is for administrators only', async () => {
    const agent = await fx.agent([]);
    expect((await failure(users.create(agent.actor, { email: fx.email('x'), displayName: 'X', role: 'AGENT', password: PASSWORD }))).code).toBe('admin_only');
    expect((await failure(users.get(agent.actor, admin.user.id))).code).toBe('admin_only');
  });
});

describe('editing accounts', () => {
  it('renames, changes the email and keeps the support profile name in step', async () => {
    const user = await created({ role: 'AGENT', name: 'Old Name' });
    const email = fx.email('renamed');
    const updated = await users.update(admin.actor, user.id, { displayName: 'New Name', email });
    expect(updated).toMatchObject({ displayName: 'New Name', normalizedEmail: email });
    expect((await prisma.agent.findUniqueOrThrow({ where: { userId: user.id } })).displayName).toBe('New Name');
    expect(updated.sessionVersion).toBe(user.sessionVersion); // not a security-relevant change
  });

  it('cannot set role, password or hash through a profile edit', async () => {
    const user = await created({ role: 'AGENT' });
    for (const sneaky of [{ role: 'ADMIN' }, { password: PASSWORD }, { passwordHash: 'x' }, { sessionVersion: 1 }]) {
      expect((await failure(users.update(admin.actor, user.id, { displayName: 'Still Ok', ...sneaky }))).code, JSON.stringify(sneaky)).toBe('validation');
    }
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).role).toBe('AGENT');
  });

  it('rejects a duplicate email and an edit that changes nothing', async () => {
    const a = await created({ role: 'AGENT' });
    const b = await created({ role: 'AGENT' });
    expect((await failure(users.update(admin.actor, b.id, { email: a.normalizedEmail }))).details).toHaveProperty('email');
    expect((await failure(users.update(admin.actor, b.id, { displayName: b.displayName }))).code).toBe('no_change');
  });
});

describe('password', () => {
  it('replaces the hash, signs the user out everywhere and enforces the length', async () => {
    const user = await created({ role: 'AGENT' });
    await users.setPassword(admin.actor, user.id, 'Another-long-passphrase');
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await verifyPassword(after.passwordHash, 'Another-long-passphrase')).toBe(true);
    expect(await verifyPassword(after.passwordHash, PASSWORD)).toBe(false);
    expect(after.sessionVersion).toBe(user.sessionVersion + 1);
    expect((await failure(users.setPassword(admin.actor, user.id, 'too short'))).code).toBe('validation');
    expect((await failure(users.setPassword(admin.actor, '00000000-0000-4000-8000-000000000000', PASSWORD))).status).toBe(404);
  });

  it('is for administrators only', async () => {
    const user = await created({ role: 'AGENT' });
    const agent = await fx.agent([]);
    expect((await failure(users.setPassword(agent.actor, user.id, PASSWORD))).code).toBe('admin_only');
  });
});

describe('role', () => {
  it('promotes and demotes, keeps or creates the support profile and signs the user out', async () => {
    const user = await created({ role: 'AGENT' });
    const promoted = await users.changeRole(admin.actor, user.id, 'ADMIN');
    expect(promoted.role).toBe('ADMIN');
    expect(promoted.sessionVersion).toBe(user.sessionVersion + 1);
    expect(await prisma.agent.findUnique({ where: { userId: user.id } })).not.toBeNull(); // can still be assigned tickets

    const boss = await created({ role: 'ADMIN' });
    const demoted = await users.changeRole(admin.actor, boss.id, 'AGENT');
    expect(demoted.role).toBe('AGENT');
    expect(await prisma.agent.findUnique({ where: { userId: boss.id } })).toMatchObject({ isActive: true }); // an AGENT always has one
  });

  it('cannot change your own role, and rejects no-ops and unknown roles', async () => {
    expect((await failure(users.changeRole(admin.actor, admin.user.id, 'AGENT'))).code).toBe('self_change');
    const user = await created({ role: 'AGENT' });
    expect((await failure(users.changeRole(admin.actor, user.id, 'AGENT'))).code).toBe('no_change');
    expect((await failure(users.changeRole(admin.actor, user.id, 'OWNER'))).code).toBe('validation');
  });

  it('lets an AGENT do none of this', async () => {
    const agent = await fx.agent([]);
    expect((await failure(users.changeRole(agent.actor, agent.user.id, 'ADMIN'))).code).toBe('admin_only');
  });
});

describe('deactivation', () => {
  it('signs the user out and deactivates the support profile, and reactivation restores it', async () => {
    const user = await created({ role: 'AGENT' });
    const off = await users.update(admin.actor, user.id, { isActive: false });
    expect(off.isActive).toBe(false);
    expect(off.sessionVersion).toBe(user.sessionVersion + 1);
    expect((await prisma.agent.findUniqueOrThrow({ where: { userId: user.id } })).isActive).toBe(false);

    const on = await users.update(admin.actor, user.id, { isActive: true });
    expect(on.isActive).toBe(true);
    expect((await prisma.agent.findUniqueOrThrow({ where: { userId: user.id } })).isActive).toBe(true);
  });

  it('is refused, with nothing changed, while the profile holds active tickets', async () => {
    const group = await fx.group();
    const customer = await fx.customer();
    const user = await created({ role: 'AGENT' });
    const profile = await prisma.agent.findUniqueOrThrow({ where: { userId: user.id } });
    await prisma.agentGroup.create({ data: { agentId: profile.id, groupId: group.id } });
    await tickets.create(admin.actor, { subject: 'Busy agent', description: 'd', customerId: customer.id, groupId: group.id, assignedAgentId: profile.id });

    expect((await failure(users.update(admin.actor, user.id, { isActive: false }))).code).toBe('has_active_tickets');
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, include: { agent: true } });
    expect(after).toMatchObject({ isActive: true, sessionVersion: user.sessionVersion });
    expect(after.agent!.isActive).toBe(true);
  });

  it('cannot deactivate yourself', async () => {
    expect((await failure(users.update(admin.actor, admin.user.id, { isActive: false }))).code).toBe('self_change');
  });
});

describe('the last administrator', () => {
  it('can be neither demoted nor deactivated; a second admin makes both possible', async () => {
    const helper = await fx.admin(); // a separate ADMIN who performs the actions
    const sole = await created({ role: 'ADMIN' });
    await onlyAdmins([sole.id, helper.user.id], async () => {
      await prisma.user.update({ where: { id: helper.user.id }, data: { isActive: false } });
      // with the helper switched off, `sole` is the only active administrator
      expect((await failure(users.changeRole(admin.actor, sole.id, 'AGENT'))).code).toBe('last_admin');
      expect((await failure(users.update(admin.actor, sole.id, { isActive: false }))).code).toBe('last_admin');
      expect((await prisma.user.findUniqueOrThrow({ where: { id: sole.id } })).role).toBe('ADMIN');

      await prisma.user.update({ where: { id: helper.user.id }, data: { isActive: true } });
      await users.changeRole(admin.actor, sole.id, 'AGENT');
    });
  });

  it('survives two administrators demoting each other at the same moment', async () => {
    // Repeated on fresh pairs: a missing lock only shows up when the two transactions actually interleave.
    for (let i = 0; i < 12; i++) {
      const a = await fx.admin();
      const b = await fx.admin();
      await onlyAdmins([a.user.id, b.user.id], async () => {
        const results = await Promise.allSettled([users.changeRole(a.actor, b.user.id, 'AGENT'), users.changeRole(b.actor, a.user.id, 'AGENT')]);
        expect(results.filter((r) => r.status === 'fulfilled'), `iteration ${i}`).toHaveLength(1);
        const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
        expect((loser.reason as DomainError).code).toBe('last_admin');
        expect(await prisma.user.count({ where: { id: { in: [a.user.id, b.user.id] }, role: 'ADMIN', isActive: true } }), `iteration ${i}`).toBe(1);
      });
    }
  });
});

describe('support profiles', () => {
  it('creates a profile for an ADMIN so they can be assigned tickets, once', async () => {
    const boss = await created({ role: 'ADMIN', name: 'Boss Admin' });
    const profile = await agents.createProfile(admin.actor, { userId: boss.id });
    expect(profile).toMatchObject({ userId: boss.id, displayName: 'Boss Admin', isActive: true });
    expect((await failure(agents.createProfile(admin.actor, { userId: boss.id }))).details).toHaveProperty('userId');
  });

  it('renames, and switches a working ADMIN profile off and on', async () => {
    const boss = await created({ role: 'ADMIN' });
    const profile = await agents.createProfile(admin.actor, { userId: boss.id });
    await agents.update(admin.actor, profile.id, { isActive: false, displayName: 'Renamed Agent' });
    expect(await prisma.agent.findUniqueOrThrow({ where: { id: profile.id } })).toMatchObject({ isActive: false, displayName: 'Renamed Agent' });
    await agents.activateAgent(admin.actor, profile.id);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: profile.id } })).isActive).toBe(true);
  });

  it('activates a profile only while the account is active', async () => {
    const boss = await created({ role: 'ADMIN' });
    const profile = await agents.createProfile(admin.actor, { userId: boss.id });
    await agents.deactivateAgent(admin.actor, profile.id);
    await users.update(admin.actor, boss.id, { isActive: false }); // other administrators exist, so this one is not the last
    expect((await failure(agents.activateAgent(admin.actor, profile.id))).details).toHaveProperty('isActive');
  });

  it('never leaves an AGENT account without an active profile', async () => {
    const user = await created({ role: 'AGENT' });
    const profile = await prisma.agent.findUniqueOrThrow({ where: { userId: user.id } });
    expect((await failure(agents.deactivateAgent(admin.actor, profile.id))).details).toHaveProperty('isActive');
    expect((await failure(agents.update(admin.actor, profile.id, { isActive: false }))).details).toHaveProperty('isActive');
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: profile.id } })).isActive).toBe(true);

    // the supported way is deactivating the account, which also signs the person out
    const off = await users.update(admin.actor, user.id, { isActive: false });
    expect(off.sessionVersion).toBe(user.sessionVersion + 1);
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: profile.id } })).isActive).toBe(false);
  });

  it('cannot switch off your own support profile', async () => {
    const worker = await fx.admin({ withAgentIn: [] });
    const err = await failure(agents.deactivateAgent(worker.actor, worker.agent!.id));
    expect(err.code).toBe('self_change');
    expect((await failure(agents.update(worker.actor, worker.agent!.id, { isActive: false }))).code).toBe('self_change');
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: worker.agent!.id } })).isActive).toBe(true);
  });

  it('is for administrators only', async () => {
    const user = await created({ role: 'AGENT' });
    const caller = await fx.agent([]);
    expect((await failure(agents.createProfile(caller.actor, { userId: user.id }))).code).toBe('admin_only');
    expect((await failure(agents.update(caller.actor, caller.agent.id, { displayName: 'Self Edit' }))).code).toBe('admin_only');
  });
});
