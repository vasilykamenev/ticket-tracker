// Deletes the demo dataset (only its own rows and files) and recreates it.
// Usage: npm run seed:reset -- --dataset takehome-demo --confirm takehome-demo [--dry-run] [--delete-only] [--seed 42]
// Needs ALLOW_DEMO_RESET=true and APP_ENV=development|demo (set explicitly); a production environment is always refused.
// The counts are printed before anything is deleted; --dry-run stops there.
import { parseArgs } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { openSeedStorage, parseSeedNumber, runCli } from '../seed/cli.js';
import { type ResetPlan, resetDemo } from '../seed/reset.js';

await runCli(async () => {
  const { values } = parseArgs({
    options: {
      dataset: { type: 'string' },
      confirm: { type: 'string' },
      'dry-run': { type: 'boolean' },
      'delete-only': { type: 'boolean' },
      seed: { type: 'string' },
    },
  });
  const dryRun = values['dry-run'] === true;
  const printPlan = (plan: ResetPlan) => {
    console.log(dryRun ? 'Dry run, nothing is deleted. A reset would remove:' : 'Removing:');
    for (const [what, n] of Object.entries(plan.rows)) console.log(`  ${what.padEnd(18)} ${n}`);
    console.log(`  ${'files'.padEnd(18)} ${plan.objects}`);
  };

  const storage = openSeedStorage();
  const prisma = new PrismaClient();
  try {
    const result = await resetDemo(
      prisma,
      storage,
      process.env,
      { dataset: values.dataset, confirm: values.confirm },
      { dryRun, deleteOnly: values['delete-only'], seed: parseSeedNumber(values.seed, 42), onPlan: printPlan },
    );
    if (result.leftoverObjects > 0) console.warn(`${result.leftoverObjects} file(s) could not be deleted; npm run storage:reconcile will remove them.`);
    if (result.seeded) {
      console.log('Recreated:');
      for (const [what, n] of Object.entries(result.seeded)) console.log(`  ${what.padEnd(18)} ${n}`);
    }
  } finally {
    await prisma.$disconnect();
  }
});
