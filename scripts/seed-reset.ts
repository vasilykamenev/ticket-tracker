// Deletes the demo dataset (only its own rows and files) and recreates it.
// Usage: npm run seed:reset -- --dataset takehome-demo --confirm takehome-demo [--dry-run] [--delete-only] [--seed 42]
// Needs ALLOW_DEMO_RESET=true and APP_ENV=development|demo; a production environment is always refused.
import { parseArgs } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { openSeedStorage, parseSeedNumber, runCli } from '../src/seed/cli.js';
import { resetDemo } from '../src/seed/run.js';

await runCli(async () => {
  const { values } = parseArgs({
    options: { dataset: { type: 'string' }, confirm: { type: 'string' }, 'dry-run': { type: 'boolean' }, 'delete-only': { type: 'boolean' }, seed: { type: 'string' } },
  });
  const storage = openSeedStorage();
  const prisma = new PrismaClient();
  try {
    const result = await resetDemo(
      prisma,
      storage,
      process.env,
      { dataset: values.dataset, confirm: values.confirm },
      { dryRunOnly: values['dry-run'], deleteOnly: values['delete-only'], seed: parseSeedNumber(values.seed, 42) },
    );
    console.log(values['dry-run'] ? 'Dry run, nothing was deleted. A reset would remove:' : 'Removed:');
    for (const [what, n] of Object.entries(result.plan.rows)) console.log(`  ${what.padEnd(14)} ${n}`);
    console.log(`  ${'files'.padEnd(14)} ${result.plan.objects}`);
    if (result.leftoverObjects > 0) console.warn(`${result.leftoverObjects} file(s) could not be deleted; npm run storage:reconcile will remove them.`);
    if (result.seeded) {
      console.log('Recreated:');
      for (const [what, n] of Object.entries(result.seeded)) console.log(`  ${what.padEnd(18)} ${n}`);
    }
  } finally {
    await prisma.$disconnect();
  }
});
