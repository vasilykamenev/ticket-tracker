// Local PostgreSQL for development without Docker (embedded-postgres). Dev only.
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';

const dataDir = '.devdb/data';
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'postgres',
  password: 'postgres',
  port: 15432,
  persistent: true,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
});

if (!existsSync(`${dataDir}/PG_VERSION`)) await pg.initialise();
await pg.start();
try {
  await pg.createDatabase('tickets');
} catch {
  // already exists
}
console.log('dev postgres ready: postgresql://postgres:postgres@localhost:15432/tickets');
process.on('SIGINT', async () => {
  await pg.stop();
  process.exit(0);
});
