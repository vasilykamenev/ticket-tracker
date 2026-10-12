import type { PrismaClient } from '@prisma/client';
import type { ObjectStorage } from '../storage/storage.js';
import { type CheckResult, type DatasetView, checkDataset } from './checks.js';
import { DATASET, type Snapshot } from './dataset.js';
import { type OwnedIds, ownedIds } from './owned.js';
import { chunks, mapLimit } from './util.js';

interface StoredAttachment {
  commentId: string;
  state: string;
  createdAt: Date;
  objectKey: string;
  sizeBytes: number;
}

/** Reads the dataset's rows back from the database: its fixed ids, and everything that hangs off its tickets. */
async function loadView(prisma: PrismaClient, ids: OwnedIds): Promise<{ view: DatasetView; attachments: StoredAttachment[] }> {
  const view: DatasetView = {
    users: (await prisma.user.findMany({ where: { id: { in: ids.userIds } }, select: { id: true, normalizedEmail: true, role: true } })).map((u) => ({
      id: u.id,
      email: u.normalizedEmail,
      role: u.role,
    })),
    agents: await prisma.agent.findMany({ where: { id: { in: ids.agentIds } }, select: { id: true, userId: true, isActive: true } }),
    groups: await prisma.supportGroup.findMany({ where: { id: { in: ids.groupIds } }, select: { id: true, name: true } }),
    memberships: await prisma.agentGroup.findMany({
      where: { OR: [{ groupId: { in: ids.groupIds } }, { agentId: { in: ids.agentIds } }] },
      select: { agentId: true, groupId: true },
    }),
    customers: [],
    tickets: [],
    history: [],
    comments: [],
    attachments: [],
  };
  for (const part of chunks(ids.customerIds)) {
    const rows = await prisma.customer.findMany({ where: { id: { in: part } }, select: { id: true, name: true, emailNormalized: true, phone: true, createdAt: true } });
    view.customers.push(...rows.map(({ emailNormalized, ...c }) => ({ ...c, email: emailNormalized })));
  }

  const attachments: StoredAttachment[] = [];
  for (const part of chunks(ids.ticketIds)) {
    for (const t of await prisma.ticket.findMany({ where: { id: { in: part } }, include: { status: true } })) {
      const { status, ...ticket } = t;
      view.tickets.push({ ...ticket, status: status.code });
    }
    for (const h of await prisma.ticketHistory.findMany({ where: { ticketId: { in: part } } })) {
      view.history.push({ ...h, before: h.before as Snapshot | null, after: h.after as Snapshot });
    }
    view.comments.push(
      ...(await prisma.comment.findMany({
        where: { ticketId: { in: part } },
        select: { id: true, ticketId: true, authorUserId: true, createdAt: true, updatedAt: true },
      })),
    );
    attachments.push(
      ...(await prisma.attachment.findMany({
        where: { comment: { ticketId: { in: part } } },
        select: { commentId: true, state: true, createdAt: true, objectKey: true, sizeBytes: true },
      })),
    );
  }
  view.attachments = attachments;
  return { view, attachments };
}

export interface VerifyResult extends CheckResult {
  filesChecked: number;
}

/** Counts, references, workflow and dates from the database, plus the presence of every seeded file in Storage. */
export async function verifyDemo(prisma: PrismaClient, storage: ObjectStorage, options: { dataset?: string; tickets?: number; concurrency?: number } = {}): Promise<VerifyResult> {
  const { view, attachments } = await loadView(prisma, ownedIds(options.dataset ?? DATASET, options.tickets));
  const result = checkDataset(view, { tickets: options.tickets });

  const storageProblems: string[] = [];
  await mapLimit(attachments, options.concurrency ?? 8, async (a) => {
    const stored = await storage.head(a.objectKey);
    if (!stored) storageProblems.push(`${a.objectKey} is missing from Storage`);
    else if (stored.size !== a.sizeBytes) storageProblems.push(`${a.objectKey} has ${stored.size} bytes in Storage, ${a.sizeBytes} in the database`);
  });
  const shown = storageProblems.slice(0, 5).map((p) => `storage: ${p}`);
  if (storageProblems.length > 5) shown.push(`storage: ... and ${storageProblems.length - 5} more`);
  return { problems: [...result.problems, ...shown], stats: result.stats, filesChecked: attachments.length };
}
