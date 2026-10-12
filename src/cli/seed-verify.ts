// Checks the demo dataset: counts, references, workflow chains, dates, memberships and the presence of every
// seeded file in Storage. Exits with 1 and lists what is wrong. Usage: npm run seed:verify -- [--tickets 2000]
// (the number the dataset was created with)
import { parseArgs } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { openSeedStorage, parseTicketCount, runCli } from '../seed/cli.js';
import { verifyDemo } from '../seed/verify.js';

await runCli(async () => {
  const { values } = parseArgs({ options: { tickets: { type: 'string' } } });
  const tickets = parseTicketCount(values.tickets);
  const storage = openSeedStorage();
  const prisma = new PrismaClient();
  try {
    const result = await verifyDemo(prisma, storage, { tickets });
    for (const [what, n] of Object.entries(result.stats)) console.log(`  ${what.padEnd(46)} ${n}`);
    console.log(`  ${'files found in Storage'.padEnd(46)} ${result.filesChecked}`);
    if (result.problems.length === 0) {
      console.log('demo dataset is consistent.');
      return 0;
    }
    console.error(`\n${result.problems.length} problem(s):`);
    for (const p of result.problems) console.error(`  - ${p}`);
    return 1;
  } finally {
    await prisma.$disconnect();
  }
});
