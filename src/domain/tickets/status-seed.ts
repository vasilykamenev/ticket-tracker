import type { PrismaClient } from '@prisma/client';
import { SYSTEM_STATUSES } from './workflow.js';

/**
 * Idempotent upsert of the six system statuses by code. Names, colors and order are only set on
 * creation so later edits made by administrators are not overwritten on re-runs.
 */
export async function ensureSystemStatuses(prisma: PrismaClient): Promise<void> {
  for (const s of SYSTEM_STATUSES) {
    await prisma.ticketStatus.upsert({
      where: { code: s.code },
      update: {},
      create: { code: s.code, name: s.name, color: s.color, sortOrder: s.sortOrder },
    });
  }
}
