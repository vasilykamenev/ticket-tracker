// Creates or completes the demo dataset (requirements section 13).
// Usage: npm run seed:demo -- [--tickets 2000] [--seed 42] [--reference-date 2026-10-01T00:00:00Z] [--rotate-demo-passwords]
// --tickets N sets the size (500 to 1000000); customers, comments and files grow with it. Verify and reset need the same N.
// Passwords come from SEED_ADMIN_PASSWORD and SEED_AGENT_PASSWORD (12+ characters), never from arguments.
// Safe to repeat: records have fixed ids and are only added when missing. Files go to the configured S3 bucket.
import { parseArgs } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { SeedGuardError } from '../seed/config.js';
import { openSeedStorage, parseSeedNumber, parseTicketCount, runCli } from '../seed/cli.js';
import { seedDemo } from '../seed/seed.js';

await runCli(async () => {
  const { values } = parseArgs({ options: { tickets: { type: 'string' }, seed: { type: 'string' }, 'reference-date': { type: 'string' }, 'rotate-demo-passwords': { type: 'boolean' } } });
  const referenceDate = values['reference-date'] ? new Date(values['reference-date']) : undefined;
  if (referenceDate && Number.isNaN(referenceDate.getTime())) throw new SeedGuardError('--reference-date must be an ISO date, e.g. 2026-10-01T00:00:00Z.');

  const storage = openSeedStorage();
  const prisma = new PrismaClient();
  try {
    const started = Date.now();
    const summary = await seedDemo(prisma, storage, process.env, {
      tickets: parseTicketCount(values.tickets),
      seed: parseSeedNumber(values.seed, 42),
      referenceDate,
      rotatePasswords: values['rotate-demo-passwords'],
      progress: (message) => console.log(`[${Math.round((Date.now() - started) / 1000)} s] ${message}`),
    });
    for (const [what, n] of Object.entries(summary)) console.log(`  ${what.padEnd(18)} ${n}`);
    console.log(`demo dataset is in place (${Math.round((Date.now() - started) / 1000)} s). Run npm run seed:verify to check it.`);
  } finally {
    await prisma.$disconnect();
  }
});
