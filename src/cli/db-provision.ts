// Creates the database roles and the schema for a deployment: a migrator (owns the schema, used only by
// `prisma migrate deploy`) and a runtime role (what the application connects as: rows only, no DDL).
// Idempotent. Run it once per database with the project owner's connection.
//
//   ADMIN_DATABASE_URL=postgresql://postgres:...@host:5432/postgres \
//   MIGRATOR_PASSWORD=... RUNTIME_PASSWORD=... \
//   node dist/cli/db-provision.js [--schema support] [--migrator migrator] [--runtime app_runtime] [--rotate-passwords]
//
// Passwords are 24+ characters, come from the environment and are never printed. Afterwards:
//   DIRECT_URL   = the migrator's URL (migration step only)     DATABASE_URL = the runtime role's URL (the application)
import { parseArgs } from 'node:util';
import pg from 'pg';
import { MIN_ROLE_PASSWORD_LENGTH, provisionRoles, validateSetup } from '../ops/db-roles.js';

const { values } = parseArgs({
  options: { schema: { type: 'string' }, migrator: { type: 'string' }, runtime: { type: 'string' }, 'rotate-passwords': { type: 'boolean' } },
});

const need = (key: string): string => {
  const value = process.env[key];
  if (!value) {
    console.error(`Set ${key}${key.endsWith('PASSWORD') ? ` (${MIN_ROLE_PASSWORD_LENGTH}+ characters)` : ''}.`);
    process.exit(2);
  }
  return value;
};

const setup = {
  schema: values.schema ?? 'support',
  migrator: values.migrator ?? 'migrator',
  runtime: values.runtime ?? 'app_runtime',
  migratorPassword: need('MIGRATOR_PASSWORD'),
  runtimePassword: need('RUNTIME_PASSWORD'),
  rotatePasswords: values['rotate-passwords'] === true,
};
try {
  validateSetup(setup);
} catch (err) {
  console.error((err as Error).message);
  process.exit(2);
}

// Prisma's ?schema= is not a node-postgres option.
const url = new URL(need('ADMIN_DATABASE_URL'));
url.searchParams.delete('schema');
const client = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 20_000 });
try {
  await client.connect();
  const report = await provisionRoles(client, setup);
  for (const line of report.created) console.log(`  created  ${line}`);
  if (report.created.length === 0) console.log('  nothing to create: the roles and the schema exist');
  for (const { check, ok } of report.checks) console.log(`  ${ok ? 'ok   ' : 'FAIL '} ${check}`);
  for (const warning of report.warnings) console.warn(`  warn   ${warning}`);
  process.exitCode = report.checks.every((c) => c.ok) ? 0 : 1;
} catch (err) {
  console.error(`Provisioning failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
