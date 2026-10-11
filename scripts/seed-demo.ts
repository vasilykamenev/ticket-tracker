// Creates or completes the demo dataset (requirements section 13).
// Usage: npm run seed:demo -- [--seed 42] [--reference-date 2026-10-01T00:00:00Z] [--rotate-demo-passwords]
// Passwords come from SEED_ADMIN_PASSWORD and SEED_AGENT_PASSWORD (12+ characters), never from arguments.
// Safe to repeat: records have fixed ids and are only added when missing. Files go to the configured S3 bucket.
import { parseArgs } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { SeedGuardError } from '../src/seed/config.js';
import { openSeedStorage, parseSeedNumber, runCli } from '../src/seed/cli.js';
import { seedDemo } from '../src/seed/run.js';

await runCli(async () => {
  const { values } = parseArgs({ options: { seed: { type: 'string' }, 'reference-date': { type: 'string' }, 'rotate-demo-passwords': { type: 'boolean' } } });
  const referenceDate = values['reference-date'] ? new Date(values['reference-date']) : undefined;
  if (referenceDate && Number.isNaN(referenceDate.getTime())) throw new SeedGuardError('--reference-date must be an ISO date, e.g. 2026-10-01T00:00:00Z.');

  const storage = openSeedStorage();
  const prisma = new PrismaClient();
  try {
    const started = Date.now();
    const summary = await seedDemo(prisma, storage, process.env, {
      seed: parseSeedNumber(values.seed, 42),
      referenceDate,
      rotatePasswords: values['rotate-demo-passwords'],
    });
    for (const [what, n] of Object.entries(summary)) console.log(`  ${what.padEnd(18)} ${n}`);
    console.log(`demo dataset is in place (${Math.round((Date.now() - started) / 1000)} s). Run npm run seed:verify to check it.`);
  } finally {
    await prisma.$disconnect();
  }
});
