import { Prisma, type PrismaClient } from '@prisma/client';
import type { ObjectStorage } from '../storage/storage.js';
import { SeedGuardError, type SeedEnv, assertResetAllowed, seedPasswords } from './config.js';
import { DATASET } from './dataset.js';
import { ownedIds } from './owned.js';
import { type SeedOptions, type SeedSummary, seedDemo } from './seed.js';
import { chunks, mapLimit } from './util.js';

export interface ResetOptions extends SeedOptions {
  /** Only report what a reset would remove. */
  dryRun?: boolean;
  /** Delete without recreating. */
  deleteOnly?: boolean;
  /** Called with the plan after the guards pass and before anything is deleted, so the operator sees the counts first. */
  onPlan?: (plan: ResetPlan) => void | Promise<void>;
}

export interface ResetPlan {
  rows: Record<string, number>;
  /** Files that would be deleted: the dataset's own keys and every file of an attachment row of its tickets. */
  objects: number;
}

/** What a reset would remove, without touching anything. */
export async function planReset(prisma: PrismaClient, dataset: string = DATASET, tickets?: number): Promise<ResetPlan & { keys: string[] }> {
  const ids = ownedIds(dataset, tickets);
  // Rows in any state count (READY, PENDING, FAILED, DELETING): their objects have to go as well.
  // A big dataset has far more ids than one statement can carry, so everything is asked for in chunks.
  const attachmentKeys: string[] = [];
  let comments = 0;
  let history = 0;
  let ticketRows = 0;
  for (const part of chunks(ids.ticketIds)) {
    const ofTickets = { ticketId: { in: part } };
    attachmentKeys.push(...(await prisma.attachment.findMany({ where: { comment: ofTickets }, select: { objectKey: true } })).map((r) => r.objectKey));
    comments += await prisma.comment.count({ where: ofTickets });
    history += await prisma.ticketHistory.count({ where: ofTickets });
    ticketRows += await prisma.ticket.count({ where: { id: { in: part } } });
  }
  let customers = 0;
  for (const part of chunks(ids.customerIds)) customers += await prisma.customer.count({ where: { id: { in: part } } });
  const keys = new Set([...ids.seedObjectKeys, ...attachmentKeys]);
  return {
    rows: {
      users: await prisma.user.count({ where: { id: { in: ids.userIds } } }),
      groups: await prisma.supportGroup.count({ where: { id: { in: ids.groupIds } } }),
      customers,
      tickets: ticketRows,
      comments,
      history,
      attachments: attachmentKeys.length,
    },
    objects: keys.size,
    keys: [...keys],
  };
}

export interface ResetResult {
  plan: ResetPlan;
  deleted: boolean;
  seeded?: SeedSummary;
  /** Files that could not be deleted; `npm run storage:reconcile` removes them later. */
  leftoverObjects: number;
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
): Promise<ResetResult> {
  const dataset = options.dataset ?? DATASET;
  assertResetAllowed(env, args, dataset);
  // Everything is recreated afterwards, which needs the account passwords: find that out before deleting anything.
  if (!options.dryRun && !options.deleteOnly) {
    const passwords = seedPasswords(env);
    if (!passwords.admin || !passwords.agent) throw new SeedGuardError('Set SEED_ADMIN_PASSWORD and SEED_AGENT_PASSWORD to recreate the dataset, or pass --delete-only.');
  }

  const plan = await planReset(prisma, dataset, options.tickets);
  await options.onPlan?.(plan);
  if (options.dryRun) return { plan, deleted: false, leftoverObjects: 0 };

  await deleteRows(prisma, ownedIds(dataset, options.tickets));
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

/** All database deletions in dependency order, in one transaction. */
async function deleteRows(prisma: PrismaClient, ids: ReturnType<typeof ownedIds>): Promise<void> {
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
      // About 20 ms per ticket with its comments and history; never less than the 2 minutes of the default dataset.
      { timeout: Math.max(120_000, ids.ticketIds.length * 20), maxWait: 10_000 },
    );
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
      throw new SeedGuardError(
        'Other records still refer to the demo data (for example a ticket created in a demo group). ' +
          'Nothing was deleted. Remove or move those records first.',
      );
    }
    throw err;
  }
}
