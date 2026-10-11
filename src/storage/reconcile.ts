import type { PrismaClient } from '@prisma/client';
import type { ObjectStorage } from './storage.js';

export interface ReconcileReport {
  dryRun: boolean;
  // Ages below are measured from the last state change, not from creation.
  /** PENDING longer than the cutoff: the object is deleted and the row marked FAILED. */
  stalePending: string[];
  /** FAILED longer than the cutoff: the object is deleted and the row removed. */
  staleFailed: string[];
  /** DELETING longer than the cutoff: the interrupted deletion is completed. */
  staleDeleting: string[];
  /** Objects with no database row (older than the cutoff): deleted. */
  orphanObjects: string[];
  /** READY rows whose object is gone. Reported only: this needs a human decision. */
  missingObjects: string[];
  /** Operations that failed; the next run retries them. */
  errors: string[];
}

export interface ReconcileOptions {
  dryRun: boolean;
  now?: Date;
  /** Anything younger than this may still be in flight and is left alone. Default one hour. */
  olderThanMs?: number;
}

const BATCH = 500;

/**
 * Brings the database and the object store back in line after crashes between the two. Idempotent, and with
 * `dryRun` it only reports. PENDING rows are converted to FAILED in this run and removed in a later one, so
 * a failed upload stays visible for at least one more cycle.
 */
export async function reconcile(prisma: PrismaClient, storage: ObjectStorage, options: ReconcileOptions): Promise<ReconcileReport> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - (options.olderThanMs ?? 60 * 60 * 1000));
  const report: ReconcileReport = { dryRun: options.dryRun, stalePending: [], staleFailed: [], staleDeleting: [], orphanObjects: [], missingObjects: [], errors: [] };

  // Decide everything up front, so rows converted below are not removed in the same run.
  const stale = (state: 'PENDING' | 'FAILED' | 'DELETING') =>
    prisma.attachment.findMany({ where: { state, stateChangedAt: { lt: cutoff } }, select: { id: true, objectKey: true } });
  const pending = await stale('PENDING');
  const failed = await stale('FAILED');
  const deleting = await stale('DELETING');

  const attempt = async (label: string, work: () => Promise<unknown>) => {
    try {
      await work();
    } catch {
      report.errors.push(label);
    }
  };

  for (const a of pending) {
    report.stalePending.push(a.id);
    if (options.dryRun) continue;
    await attempt(`pending ${a.id}`, async () => {
      await storage.delete(a.objectKey);
      await prisma.attachment.updateMany({ where: { id: a.id, state: 'PENDING' }, data: { state: 'FAILED', stateChangedAt: new Date() } });
    });
  }
  for (const a of failed) {
    report.staleFailed.push(a.id);
    if (options.dryRun) continue;
    await attempt(`failed ${a.id}`, async () => {
      await storage.delete(a.objectKey);
      await prisma.attachment.deleteMany({ where: { id: a.id, state: 'FAILED' } });
    });
  }
  for (const a of deleting) {
    report.staleDeleting.push(a.id);
    if (options.dryRun) continue;
    await attempt(`deleting ${a.id}`, async () => {
      await storage.delete(a.objectKey);
      await prisma.attachment.deleteMany({ where: { id: a.id, state: 'DELETING' } });
    });
  }

  // Objects nobody knows about, in batches so a large bucket never sits in memory at once.
  let batch: { key: string; lastModified: Date }[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const known = new Set((await prisma.attachment.findMany({ where: { objectKey: { in: batch.map((o) => o.key) } }, select: { objectKey: true } })).map((r) => r.objectKey));
    for (const object of batch) {
      if (known.has(object.key) || object.lastModified >= cutoff) continue;
      report.orphanObjects.push(object.key);
      if (!options.dryRun) await attempt(`orphan ${object.key}`, () => storage.delete(object.key));
    }
    batch = [];
  };
  try {
    for await (const object of storage.list('tickets/')) {
      batch.push({ key: object.key, lastModified: object.lastModified });
      if (batch.length >= BATCH) await flush();
    }
    await flush();
  } catch {
    report.errors.push('listing objects');
  }

  // READY rows whose object has disappeared.
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.attachment.findMany({
      where: { state: 'READY' },
      select: { id: true, objectKey: true },
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      try {
        if (!(await storage.head(row.objectKey))) report.missingObjects.push(row.id);
      } catch {
        report.errors.push(`head ${row.id}`);
      }
    }
    cursor = rows[rows.length - 1]!.id;
  }
  return report;
}
