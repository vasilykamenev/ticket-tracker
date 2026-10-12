import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { hashPassword } from '../auth/password.js';
import { ensureSystemStatuses } from '../domain/tickets/status-seed.js';
import { normalizeEmail } from '../domain/users/email.js';
import { validateUpload } from '../storage/file-validation.js';
import type { ObjectStorage } from '../storage/storage.js';
import { type SeedEnv, SeedGuardError, assertSeedAllowed, seedPasswords } from './config.js';
import {
  type DatasetOptions,
  type SeedAttachment,
  type SeedComment,
  type SeedCustomer,
  type SeedDataset,
  type SeedHistory,
  type SeedTicket,
  type SeedUser,
  generateDataset,
} from './dataset.js';
import { chunks, insertAll, mapLimit } from './util.js';

export interface SeedOptions extends DatasetOptions {
  /** Give the existing demo accounts new passwords (and end their sessions). */
  rotatePasswords?: boolean;
  /** Parallel uploads and storage checks. */
  concurrency?: number;
  /** Told about each step; a big dataset takes a while and the operator should see it move. */
  progress?: (message: string) => void;
}

/** How many records of each kind were added (or repaired) by one run. */
export type SeedSummary = Record<string, number>;

// ---- how a generated record becomes a database row

const userRow = (u: SeedUser, passwordHash: string) => ({
  id: u.id,
  normalizedEmail: normalizeEmail(u.email),
  displayName: u.displayName,
  passwordHash,
  role: u.role,
  createdAt: u.createdAt,
  updatedAt: u.createdAt,
});

const customerRow = (c: SeedCustomer) => ({
  id: c.id,
  name: c.name,
  emailNormalized: normalizeEmail(c.email),
  company: c.company,
  phone: c.phone,
  createdAt: c.createdAt,
  updatedAt: c.createdAt,
});

const ticketRow = (t: SeedTicket, statusId: string) => ({
  id: t.id,
  // Fixed numbers for the default dataset; otherwise the database sequence assigns them.
  ...(t.number !== null ? { number: t.number } : {}),
  subject: t.subject,
  description: t.description,
  customerId: t.customerId,
  groupId: t.groupId,
  assignedAgentId: t.assignedAgentId,
  statusId,
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
});

const historyRow = (h: SeedHistory) => ({
  id: h.id,
  ticketId: h.ticketId,
  actorUserId: h.actorUserId,
  kind: h.kind,
  before: (h.before as Prisma.InputJsonValue | null) ?? undefined,
  after: h.after as Prisma.InputJsonValue,
  reason: h.reason,
  createdAt: h.createdAt,
});

const commentRow = (c: SeedComment) => ({
  id: c.id,
  ticketId: c.ticketId,
  authorUserId: c.authorUserId,
  body: c.body,
  version: c.version,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

interface StoredFile {
  attachment: SeedAttachment;
  bytes: Buffer;
  contentType: SeedAttachment['contentType'];
  /** False for a file that had vanished from Storage while its row still existed. */
  isNew: boolean;
}

const attachmentRow = (f: StoredFile, bucket: string) => ({
  id: f.attachment.id,
  commentId: f.attachment.commentId,
  bucket,
  objectKey: f.attachment.objectKey,
  originalName: f.attachment.originalName,
  contentType: f.contentType,
  sizeBytes: f.bytes.length,
  sha256: createHash('sha256').update(f.bytes).digest('hex'),
  state: 'READY' as const,
  createdByUserId: f.attachment.createdByUserId,
  createdAt: f.attachment.createdAt,
  stateChangedAt: f.attachment.createdAt,
});

// ---- the run

/**
 * Creates the dataset, or completes it: every record has a fixed id and is inserted only when missing, so a
 * rerun adds nothing twice and repairs what is absent (including files that vanished from Storage). Rows that
 * already exist are left as they are; to regenerate with another seed, reset first.
 */
export async function seedDemo(prisma: PrismaClient, storage: ObjectStorage, env: SeedEnv, options: SeedOptions = {}): Promise<SeedSummary> {
  assertSeedAllowed(env);
  await ensureSystemStatuses(prisma);
  options.progress?.('generating the dataset in memory');
  const data = generateDataset(options);
  const created: SeedSummary = {};
  const add = (what: string, n: number) => {
    created[what] = (created[what] ?? 0) + n;
    options.progress?.(`${what}: ${n} added`);
  };

  // Nothing is written before every conflict with other people's rows and every missing password is known.
  await assertNoForeignConflicts(prisma, data);
  const existing = new Set((await prisma.user.findMany({ where: { id: { in: data.users.map((u) => u.id) } }, select: { id: true } })).map((u) => u.id));
  const hashes = await hashAccountPasswords(data.users, existing, env, options.rotatePasswords === true);

  add('users', await prisma.user.createMany({
    data: data.users.filter((u) => !existing.has(u.id)).map((u) => userRow(u, hashes.get(u.id)!)),
    skipDuplicates: true,
  }).then((r) => r.count));
  if (options.rotatePasswords) {
    for (const u of data.users.filter((x) => existing.has(x.id))) {
      await prisma.user.update({ where: { id: u.id }, data: { passwordHash: hashes.get(u.id)!, sessionVersion: { increment: 1 } } });
    }
    add('passwords rotated', existing.size);
  }

  add('agents', (await prisma.agent.createMany({ data: data.agents, skipDuplicates: true })).count);
  add('groups', (await prisma.supportGroup.createMany({ data: data.groups, skipDuplicates: true })).count);
  add('memberships', (await prisma.agentGroup.createMany({ data: data.memberships, skipDuplicates: true })).count);
  add('customers', await insertAll(data.customers.map(customerRow), (rows) => prisma.customer.createMany({ data: rows, skipDuplicates: true })));

  const statusIds = new Map((await prisma.ticketStatus.findMany()).map((s) => [s.code, s.id]));
  add('tickets', await insertAll(data.tickets.map((t) => ticketRow(t, statusIds.get(t.status)!)), (rows) => prisma.ticket.createMany({ data: rows, skipDuplicates: true })));
  if (data.tickets.some((t) => t.number !== null)) await moveSequencePastTickets(prisma);
  add('history', await insertAll(data.history.map(historyRow), (rows) => prisma.ticketHistory.createMany({ data: rows, skipDuplicates: true })));
  add('comments', await insertAll(data.comments.map(commentRow), (rows) => prisma.comment.createMany({ data: rows, skipDuplicates: true })));

  // Files first, rows after: a row never points at an object that was not stored.
  const stored = await storeFiles(prisma, storage, data.attachments, options.concurrency ?? 4);
  add('files uploaded', stored.length); // new files and files that had vanished from Storage
  const newRows = stored.filter((f) => f.isNew).map((f) => attachmentRow(f, storage.bucket));
  add('attachments', await insertAll(newRows, (rows) => prisma.attachment.createMany({ data: rows, skipDuplicates: true }), 200));
  return created;
}

/** One Argon2 hash per account (each gets its own salt); existing passwords stay unless rotation is asked for. */
async function hashAccountPasswords(users: SeedUser[], existing: Set<string>, env: SeedEnv, rotate: boolean): Promise<Map<string, string>> {
  const passwords = seedPasswords(env);
  const needed = (role: SeedUser['role']) => users.some((u) => u.role === role && (!existing.has(u.id) || rotate));
  if (needed('ADMIN') && !passwords.admin) throw new SeedGuardError('Set SEED_ADMIN_PASSWORD (12+ characters) to create or rotate the demo administrators.');
  if (needed('AGENT') && !passwords.agent) throw new SeedGuardError('Set SEED_AGENT_PASSWORD (12+ characters) to create or rotate the demo agents.');

  const hashes = new Map<string, string>();
  for (const u of users) {
    if (existing.has(u.id) && !rotate) continue;
    hashes.set(u.id, await hashPassword(u.role === 'ADMIN' ? passwords.admin! : passwords.agent!));
  }
  return hashes;
}

/** Uploads the files that are not (completely) in Storage yet and returns what was stored. */
async function storeFiles(prisma: PrismaClient, storage: ObjectStorage, attachments: SeedAttachment[], concurrency: number): Promise<StoredFile[]> {
  const rows = new Map(
    (await prisma.attachment.findMany({ where: { id: { in: attachments.map((a) => a.id) } }, select: { id: true, objectKey: true, sizeBytes: true } })).map((r) => [r.id, r]),
  );
  const results = await mapLimit(attachments, concurrency, async (attachment): Promise<StoredFile | null> => {
    const row = rows.get(attachment.id);
    if (row && (await storage.head(row.objectKey))?.size === row.sizeBytes) return null; // present and complete
    const bytes = attachment.build();
    const { contentType } = validateUpload({ originalName: attachment.originalName, declaredType: attachment.contentType, data: bytes });
    await storage.put(attachment.objectKey, bytes, contentType);
    return { attachment, bytes, contentType, isNew: !row };
  });
  return results.filter((f): f is StoredFile => f !== null);
}

/** Explicit ticket numbers do not advance the sequence: move it past them so the next ticket gets a free number. */
async function moveSequencePastTickets(prisma: PrismaClient): Promise<void> {
  await prisma.$queryRaw`
    SELECT setval(pg_get_serial_sequence('support."Ticket"', 'number'), GREATEST((SELECT COALESCE(MAX(number), 1) FROM support."Ticket"), 1))`;
}

/** A demo address, group code or ticket number that already belongs to somebody else's row would break the insert half-way. */
async function assertNoForeignConflicts(prisma: PrismaClient, data: SeedDataset): Promise<void> {
  // Looked up in chunks (a database statement takes a limited number of parameters) and compared with the id the
  // dataset itself would give the row: a row with the demo address but another id is somebody else's.
  const foreign = async <K extends string | number>(
    keys: Array<[K, string]>,
    find: (part: K[]) => Promise<Array<{ key: K; id: string }>>,
  ): Promise<K[]> => {
    const expected = new Map(keys);
    const clashes: K[] = [];
    for (const part of chunks(keys.map(([key]) => key))) {
      for (const row of await find(part)) if (expected.get(row.key) !== row.id) clashes.push(row.key);
    }
    return clashes;
  };
  const users = await foreign(
    data.users.map((u) => [normalizeEmail(u.email), u.id]),
    async (part) => (await prisma.user.findMany({ where: { normalizedEmail: { in: part } }, select: { id: true, normalizedEmail: true } })).map((r) => ({ key: r.normalizedEmail, id: r.id })),
  );
  const customers = await foreign(
    data.customers.map((c) => [normalizeEmail(c.email), c.id]),
    async (part) => (await prisma.customer.findMany({ where: { emailNormalized: { in: part } }, select: { id: true, emailNormalized: true } })).map((r) => ({ key: r.emailNormalized, id: r.id })),
  );
  const groups = await foreign(
    data.groups.map((g) => [g.code, g.id]),
    async (part) => (await prisma.supportGroup.findMany({ where: { code: { in: part } }, select: { id: true, code: true } })).map((r) => ({ key: r.code, id: r.id })),
  );
  const tickets = await foreign(
    data.tickets.flatMap((t): Array<[number, string]> => (t.number === null ? [] : [[t.number, t.id]])),
    async (part) => (await prisma.ticket.findMany({ where: { number: { in: part } }, select: { id: true, number: true } })).map((r) => ({ key: r.number, id: r.id })),
  );
  const clashes = [...tickets.map((n) => `ticket number ${n}`), ...users, ...customers, ...groups.map((g) => `group ${g}`)];
  if (clashes.length > 0) {
    const shown = clashes.slice(0, 5).join(', ') + (clashes.length > 5 ? ', ...' : '');
    throw new SeedGuardError(`These already exist and are not part of the demo dataset: ${shown}. Nothing was changed.`);
  }
}
