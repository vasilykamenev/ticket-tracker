import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { hashPassword } from '../auth/password.js';
import { ensureSystemStatuses } from '../domain/tickets/status-seed.js';
import { normalizeEmail } from '../domain/users/email.js';
import { validateUpload } from '../storage/file-validation.js';
import type { ObjectStorage } from '../storage/storage.js';
import { checkDataset, type CheckResult, type DatasetView } from './checks.js';
import { SeedGuardError, type SeedEnv, assertResetAllowed, assertSeedAllowed, seedPasswords } from './config.js';
import { DATASET, type DatasetOptions, type SeedDataset, type Snapshot, generateDataset } from './dataset.js';

export interface SeedOptions extends DatasetOptions {
  /** Give the existing demo accounts new passwords (and end their sessions). */
  rotatePasswords?: boolean;
  /** Parallel uploads and storage checks. */
  concurrency?: number;
}

const CHUNK = 1000;
const chunks = <T>(items: T[], size = CHUNK): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const at = next++;
        results[at] = await work(items[at]!);
      }
    }),
  );
  return results;
}

/** The ids that belong to a dataset: they depend only on the dataset name, never on the random seed. */
export function ownedIds(dataset: string) {
  const d = generateDataset({ dataset });
  return {
    userIds: d.users.map((u) => u.id),
    agentIds: d.agents.map((a) => a.id),
    groupIds: d.groups.map((g) => g.id),
    customerIds: d.customers.map((c) => c.id),
    ticketIds: d.tickets.map((t) => t.id),
    seedObjectKeys: d.attachments.map((a) => a.objectKey),
  };
}

export type SeedSummary = Record<string, number>;

/**
 * Creates the dataset, or completes it: every record has a fixed id and is inserted only when missing, so a
 * rerun adds nothing twice and repairs what is absent (including files that vanished from Storage). Rows that
 * already exist are left as they are; to regenerate with another seed, reset first.
 */
export async function seedDemo(prisma: PrismaClient, storage: ObjectStorage, env: SeedEnv, options: SeedOptions = {}): Promise<SeedSummary> {
  assertSeedAllowed(env);
  const concurrency = options.concurrency ?? 4;
  await ensureSystemStatuses(prisma);
  const data = generateDataset(options);
  const created: SeedSummary = {};
  const count = (what: string, n: number) => (created[what] = (created[what] ?? 0) + n);

  // Nothing is written before every conflict with other people's rows is known.
  await assertNoForeignConflicts(prisma, data);
  const existingUsers = new Set((await prisma.user.findMany({ where: { id: { in: data.users.map((u) => u.id) } }, select: { id: true } })).map((u) => u.id));
  const passwords = seedPasswords(env);
  const needsPassword = (role: 'ADMIN' | 'AGENT') => data.users.some((u) => u.role === role && (!existingUsers.has(u.id) || options.rotatePasswords));
  if (needsPassword('ADMIN') && !passwords.admin) throw new SeedGuardError('Set SEED_ADMIN_PASSWORD (12+ characters) to create or rotate the demo administrators.');
  if (needsPassword('AGENT') && !passwords.agent) throw new SeedGuardError('Set SEED_AGENT_PASSWORD (12+ characters) to create or rotate the demo agents.');

  // Accounts: one hash per account (each gets its own salt). Existing passwords stay unless rotation is asked for.
  const hashed = new Map<string, string>();
  for (const u of data.users) {
    if (!existingUsers.has(u.id) || options.rotatePasswords) hashed.set(u.id, await hashPassword(u.role === 'ADMIN' ? passwords.admin! : passwords.agent!));
  }
  const newUsers = data.users.filter((u) => !existingUsers.has(u.id));
  count('users', (await prisma.user.createMany({ data: newUsers.map((u) => ({ id: u.id, normalizedEmail: normalizeEmail(u.email), displayName: u.displayName, passwordHash: hashed.get(u.id)!, role: u.role, createdAt: u.createdAt, updatedAt: u.createdAt })), skipDuplicates: true })).count);
  if (options.rotatePasswords) {
    for (const u of data.users.filter((x) => existingUsers.has(x.id))) {
      await prisma.user.update({ where: { id: u.id }, data: { passwordHash: hashed.get(u.id)!, sessionVersion: { increment: 1 } } });
    }
    count('passwords rotated', existingUsers.size);
  }
  count('agents', (await prisma.agent.createMany({ data: data.agents, skipDuplicates: true })).count);
  count('groups', (await prisma.supportGroup.createMany({ data: data.groups, skipDuplicates: true })).count);
  count('memberships', (await prisma.agentGroup.createMany({ data: data.memberships, skipDuplicates: true })).count);
  for (const part of chunks(data.customers)) {
    count('customers', (await prisma.customer.createMany({ data: part.map((c) => ({ id: c.id, name: c.name, emailNormalized: normalizeEmail(c.email), company: c.company, phone: c.phone, createdAt: c.createdAt, updatedAt: c.createdAt })), skipDuplicates: true })).count);
  }

  const statusIds = new Map((await prisma.ticketStatus.findMany()).map((s) => [s.code, s.id]));
  for (const part of chunks(data.tickets)) {
    const { count: n } = await prisma.ticket.createMany({
      data: part.map((t) => ({
        id: t.id,
        ...(t.number !== null ? { number: t.number } : {}),
        subject: t.subject,
        description: t.description,
        customerId: t.customerId,
        groupId: t.groupId,
        assignedAgentId: t.assignedAgentId,
        statusId: statusIds.get(t.status)!,
        priority: t.priority,
        resolution: t.resolution,
        unresolvedReason: t.unresolvedReason,
        resolvedAt: t.resolvedAt,
        unresolvedAt: t.unresolvedAt,
        closedAt: t.closedAt,
        createdByUserId: t.createdByUserId,
        version: t.version,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
      skipDuplicates: true,
    });
    count('tickets', n);
  }
  if (data.tickets.some((t) => t.number !== null)) {
    // Explicit numbers do not advance the sequence: move it past them so the next ticket gets a free number.
    await prisma.$queryRaw`SELECT setval(pg_get_serial_sequence('support."Ticket"', 'number'), GREATEST((SELECT COALESCE(MAX(number), 1) FROM support."Ticket"), 1))`;
  }
  for (const part of chunks(data.history)) {
    count('history', (await prisma.ticketHistory.createMany({ data: part.map((h) => ({ id: h.id, ticketId: h.ticketId, actorUserId: h.actorUserId, kind: h.kind, before: (h.before as Prisma.InputJsonValue | null) ?? undefined, after: h.after as Prisma.InputJsonValue, reason: h.reason, createdAt: h.createdAt })), skipDuplicates: true })).count);
  }
  for (const part of chunks(data.comments)) {
    count('comments', (await prisma.comment.createMany({ data: part.map((c) => ({ id: c.id, ticketId: c.ticketId, authorUserId: c.authorUserId, body: c.body, version: c.version, createdAt: c.createdAt, updatedAt: c.updatedAt })), skipDuplicates: true })).count);
  }

  // Files first, rows after: a row never points at an object that was not stored.
  const existingRows = new Map((await prisma.attachment.findMany({ where: { id: { in: data.attachments.map((a) => a.id) } }, select: { id: true, objectKey: true, sizeBytes: true } })).map((r) => [r.id, r]));
  const uploads = await mapLimit(data.attachments, concurrency, async (a) => {
    const row = existingRows.get(a.id);
    if (row) {
      const stored = await storage.head(row.objectKey);
      if (stored?.size === row.sizeBytes) return null; // present and complete
    }
    const bytes = a.build();
    const checked = validateUpload({ originalName: a.originalName, declaredType: a.contentType, data: bytes });
    await storage.put(a.objectKey, bytes, checked.contentType);
    return { attachment: a, bytes, contentType: checked.contentType, isNew: !row };
  });
  const stored = uploads.filter((u): u is NonNullable<typeof u> => u !== null);
  count('files uploaded', stored.length); // new files and files that had vanished from Storage
  const fresh = stored.filter((u) => u.isNew); // only new files need a row
  for (const part of chunks(fresh, 200)) {
    count('attachments', (await prisma.attachment.createMany({
      data: part.map(({ attachment: a, bytes, contentType }) => ({
        id: a.id,
        commentId: a.commentId,
        bucket: storage.bucket,
        objectKey: a.objectKey,
        originalName: a.originalName,
        contentType,
        sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        state: 'READY' as const,
        createdByUserId: a.createdByUserId,
        createdAt: a.createdAt,
        stateChangedAt: a.createdAt,
      })),
      skipDuplicates: true,
    })).count);
  }
  return created;
}

/** A demo e-mail address or group code that already belongs to somebody else's row would break the insert half-way. */
async function assertNoForeignConflicts(prisma: PrismaClient, data: SeedDataset): Promise<void> {
  const [users, customers, groups] = await Promise.all([
    prisma.user.findMany({ where: { normalizedEmail: { in: data.users.map((u) => normalizeEmail(u.email)) }, id: { notIn: data.users.map((u) => u.id) } }, select: { normalizedEmail: true } }),
    prisma.customer.findMany({ where: { emailNormalized: { in: data.customers.map((c) => normalizeEmail(c.email)) }, id: { notIn: data.customers.map((c) => c.id) } }, select: { emailNormalized: true } }),
    prisma.supportGroup.findMany({ where: { code: { in: data.groups.map((g) => g.code) }, id: { notIn: data.groups.map((g) => g.id) } }, select: { code: true } }),
  ]);
  const numbers = data.tickets.flatMap((t) => (t.number === null ? [] : [t.number]));
  const taken = numbers.length === 0 ? [] : await prisma.ticket.findMany({ where: { number: { in: numbers }, id: { notIn: data.tickets.map((t) => t.id) } }, select: { number: true } });
  const clashes = [...taken.map((t) => `ticket number ${t.number}`), ...users.map((u) => u.normalizedEmail), ...customers.map((c) => c.emailNormalized), ...groups.map((g) => `group ${g.code}`)];
  if (clashes.length > 0) throw new SeedGuardError(`These already exist and are not part of the demo dataset: ${clashes.slice(0, 5).join(', ')}${clashes.length > 5 ? ', ...' : ''}. Nothing was changed.`);
}

// ---------------------------------------------------------------- reading the dataset back

async function loadView(prisma: PrismaClient, dataset: string) {
  const ids = ownedIds(dataset);
  const users = await prisma.user.findMany({ where: { id: { in: ids.userIds } }, select: { id: true, role: true } });
  const agents = await prisma.agent.findMany({ where: { id: { in: ids.agentIds } }, select: { id: true, userId: true } });
  const groups = await prisma.supportGroup.findMany({ where: { id: { in: ids.groupIds } }, select: { id: true, name: true } });
  const memberships = await prisma.agentGroup.findMany({ where: { OR: [{ groupId: { in: ids.groupIds } }, { agentId: { in: ids.agentIds } }] }, select: { agentId: true, groupId: true } });
  const customers: DatasetView['customers'] = [];
  for (const part of chunks(ids.customerIds)) customers.push(...(await prisma.customer.findMany({ where: { id: { in: part } }, select: { id: true, name: true, phone: true, createdAt: true } })));
  const tickets: DatasetView['tickets'] = [];
  const history: DatasetView['history'] = [];
  const comments: DatasetView['comments'] = [];
  const attachments: Array<DatasetView['attachments'][number] & { objectKey: string; sizeBytes: number }> = [];
  for (const part of chunks(ids.ticketIds)) {
    for (const t of await prisma.ticket.findMany({ where: { id: { in: part } }, include: { status: true } })) {
      tickets.push({ id: t.id, subject: t.subject, customerId: t.customerId, groupId: t.groupId, assignedAgentId: t.assignedAgentId, status: t.status.code, resolution: t.resolution, unresolvedReason: t.unresolvedReason, resolvedAt: t.resolvedAt, unresolvedAt: t.unresolvedAt, closedAt: t.closedAt, version: t.version, createdAt: t.createdAt, updatedAt: t.updatedAt });
    }
    for (const h of await prisma.ticketHistory.findMany({ where: { ticketId: { in: part } } })) {
      history.push({ ticketId: h.ticketId, actorUserId: h.actorUserId, kind: h.kind, before: h.before as Snapshot | null, after: h.after as Snapshot, reason: h.reason, createdAt: h.createdAt });
    }
    for (const c of await prisma.comment.findMany({ where: { ticketId: { in: part } }, select: { ticketId: true, authorUserId: true, createdAt: true, updatedAt: true } })) comments.push(c);
    for (const a of await prisma.attachment.findMany({ where: { comment: { ticketId: { in: part } } }, select: { commentId: true, state: true, objectKey: true, sizeBytes: true } })) attachments.push(a);
  }
  const view: DatasetView = { users, agents, groups, memberships, customers, tickets, history, comments, attachments };
  return { view, attachments, ids };
}

export interface VerifyResult extends CheckResult {
  filesChecked: number;
}

/** Counts, references, workflow and dates from the database, plus the presence of every seeded file in Storage. */
export async function verifyDemo(prisma: PrismaClient, storage: ObjectStorage, options: { dataset?: string; concurrency?: number } = {}): Promise<VerifyResult> {
  const { view, attachments } = await loadView(prisma, options.dataset ?? DATASET);
  const result = checkDataset(view);
  const missing: string[] = [];
  await mapLimit(attachments, options.concurrency ?? 8, async (a) => {
    const stored = await storage.head(a.objectKey);
    if (!stored) missing.push(`${a.objectKey} is missing from Storage`);
    else if (stored.size !== a.sizeBytes) missing.push(`${a.objectKey} has ${stored.size} bytes in Storage, ${a.sizeBytes} in the database`);
  });
  for (const m of missing.slice(0, 5)) result.problems.push(`storage: ${m}`);
  if (missing.length > 5) result.problems.push(`storage: ... and ${missing.length - 5} more`);
  return { ...result, filesChecked: attachments.length };
}

// ---------------------------------------------------------------- reset

export interface ResetOptions extends SeedOptions {
  confirm?: string;
  dryRunOnly?: boolean;
  /** Delete without recreating. */
  deleteOnly?: boolean;
}

export interface ResetPlan {
  rows: Record<string, number>;
  objects: number;
}

/** What a reset would remove, without touching anything. */
export async function planReset(prisma: PrismaClient, dataset: string = DATASET): Promise<ResetPlan & { keys: string[] }> {
  const ids = ownedIds(dataset);
  const where = { ticketId: { in: ids.ticketIds } };
  const keys = new Set(ids.seedObjectKeys);
  const rows = await prisma.attachment.findMany({ where: { comment: where }, select: { objectKey: true } });
  rows.forEach((r) => keys.add(r.objectKey));
  return {
    rows: {
      users: await prisma.user.count({ where: { id: { in: ids.userIds } } }),
      groups: await prisma.supportGroup.count({ where: { id: { in: ids.groupIds } } }),
      customers: await prisma.customer.count({ where: { id: { in: ids.customerIds } } }),
      tickets: await prisma.ticket.count({ where: { id: { in: ids.ticketIds } } }),
      comments: await prisma.comment.count({ where }),
      history: await prisma.ticketHistory.count({ where }),
      attachments: rows.length,
    },
    objects: keys.size,
    keys: [...keys],
  };
}

/**
 * Deletes exactly the demo dataset (rows by their fixed ids, objects by their keys) and recreates it. The database
 * part is one transaction: if anything else still refers to the demo rows, nothing is deleted. Never drops a
 * schema, truncates a table or lists the whole bucket.
 */
export async function resetDemo(
  prisma: PrismaClient,
  storage: ObjectStorage,
  env: SeedEnv,
  args: { dataset?: string; confirm?: string },
  options: ResetOptions = {},
): Promise<{ plan: ResetPlan; deleted: boolean; seeded?: SeedSummary; leftoverObjects: number }> {
  const dataset = options.dataset ?? DATASET;
  assertResetAllowed(env, args, dataset);
  const plan = await planReset(prisma, dataset);
  if (options.dryRunOnly) return { plan, deleted: false, leftoverObjects: 0 };

  // Everything is recreated afterwards, which needs the account passwords: find that out before deleting anything.
  if (!options.deleteOnly) {
    const passwords = seedPasswords(env);
    if (!passwords.admin || !passwords.agent) throw new SeedGuardError('Set SEED_ADMIN_PASSWORD and SEED_AGENT_PASSWORD to recreate the dataset, or pass --delete-only.');
  }
  const ids = ownedIds(dataset);
  try {
    await prisma.$transaction(
      async (tx) => {
        for (const part of chunks(ids.ticketIds)) {
          await tx.attachment.deleteMany({ where: { comment: { ticketId: { in: part } } } });
          await tx.comment.deleteMany({ where: { ticketId: { in: part } } });
          await tx.ticketHistory.deleteMany({ where: { ticketId: { in: part } } });
          await tx.ticket.deleteMany({ where: { id: { in: part } } });
        }
        await tx.agentGroup.deleteMany({ where: { OR: [{ groupId: { in: ids.groupIds } }, { agentId: { in: ids.agentIds } }] } });
        await tx.$executeRaw`DELETE FROM support."Session" WHERE (sess->>'userId') = ANY(${ids.userIds}::text[])`;
        await tx.agent.deleteMany({ where: { id: { in: ids.agentIds } } });
        await tx.user.deleteMany({ where: { id: { in: ids.userIds } } });
        await tx.supportGroup.deleteMany({ where: { id: { in: ids.groupIds } } });
        for (const part of chunks(ids.customerIds)) await tx.customer.deleteMany({ where: { id: { in: part } } });
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
      throw new SeedGuardError('Other records still refer to the demo data (for example a ticket created in a demo group). Nothing was deleted. Remove or move those records first.');
    }
    throw err;
  }

  if (options.deleteOnly && dataset === DATASET && (await prisma.ticket.count()) === 0) {
    // The demo took the numbers 1001..3000; with no ticket left, numbering starts from 1 again.
    await prisma.$queryRaw`SELECT setval(pg_get_serial_sequence('support."Ticket"', 'number'), 1, false)`;
  }

  // The files go after the rows: a failure here leaves harmless orphans that `npm run storage:reconcile` removes.
  let leftover = 0;
  await mapLimit(plan.keys, options.concurrency ?? 8, async (key) => {
    try {
      await storage.delete(key);
    } catch {
      leftover++;
    }
  });
  const seeded = options.deleteOnly ? undefined : await seedDemo(prisma, storage, env, options);
  return { plan, deleted: true, seeded, leftoverObjects: leftover };
}
