// Brings database rows and stored objects back in line after crashes. Usage:
//   npm run storage:reconcile -- --dry-run      (report only)
//   npm run storage:reconcile                   (fix)
// Anything younger than --older-than-minutes (default 60) may still be in flight and is left alone.
import { parseArgs } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { loadStorageEnv } from '../config/env.js';
import { createStorage } from '../storage/index.js';
import { reconcile } from '../storage/reconcile.js';

const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false }, 'older-than-minutes': { type: 'string', default: '60' } } });
const minutes = Number(values['older-than-minutes']);
if (!Number.isFinite(minutes) || minutes < 1) {
  console.error('--older-than-minutes must be a number of at least 1');
  process.exit(1);
}

const prisma = new PrismaClient();
try {
  const report = await reconcile(prisma, createStorage(loadStorageEnv()), { dryRun: values['dry-run'] === true, olderThanMs: minutes * 60_000 });
  const counts = Object.entries(report).filter(([, v]) => Array.isArray(v)).map(([k, v]) => `${k}: ${(v as unknown[]).length}`);
  console.log(`${report.dryRun ? 'DRY RUN, nothing changed. ' : ''}${counts.join(', ')}`);
  for (const [name, list] of Object.entries(report)) {
    if (Array.isArray(list) && list.length > 0) console.log(`\n${name}:\n  ${(list as string[]).join('\n  ')}`);
  }
  process.exitCode = report.errors.length > 0 ? 1 : 0;
} finally {
  await prisma.$disconnect();
}
