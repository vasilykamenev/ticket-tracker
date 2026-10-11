// Idempotent: upserts the six system ticket statuses by code. Safe to run repeatedly.
import { PrismaClient } from '@prisma/client';
import { ensureSystemStatuses } from '../domain/tickets/status-seed.js';

const prisma = new PrismaClient();
try {
  await ensureSystemStatuses(prisma);
  console.log('System statuses are in place.');
} finally {
  await prisma.$disconnect();
}
