import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RoleSetup, provisionRoles, validateSetup } from '../../src/ops/db-roles.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for integration tests (see .env.example)');

// Roles live in the whole cluster, so every name carries a run id, and everything is dropped again afterwards.
const run = randomUUID().slice(0, 8);
const password = () => randomBytes(24).toString('base64url');
const base: RoleSetup = { schema: `s_${run}`, migrator: `mig_${run}`, runtime: `run_${run}`, migratorPassword: password(), runtimePassword: password() };
const adoptedSchema = `adopt_${run}`;

function url(user: string, secret: string): string {
  const u = new URL(process.env.DATABASE_URL!);
  u.searchParams.delete('schema');
  u.username = user;
  u.password = secret;
  return u.toString();
}
async function connect(user: string, secret: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url(user, secret) });
  await client.connect();
  return client;
}
const adminUrl = (() => {
  const u = new URL(process.env.DATABASE_URL!);
  u.searchParams.delete('schema');
  return u.toString();
})();
const admin = new pg.Client({ connectionString: adminUrl });

async function failureOf(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, 'expected the statement to be refused').toBeInstanceOf(Error);
  return (err as Error).message;
}

beforeAll(async () => {
  await admin.connect();
});

afterAll(async () => {
  for (const schema of [base.schema, adoptedSchema]) await admin.query(`drop schema if exists ${admin.escapeIdentifier(schema)} cascade`);
  for (const role of [base.runtime, base.migrator]) {
    await admin.query(`drop owned by ${admin.escapeIdentifier(role)}`).catch(() => undefined);
    await admin.query(`drop role if exists ${admin.escapeIdentifier(role)}`);
  }
  await admin.end();
});

describe('database roles', () => {
  it('creates the roles and the schema, and every check passes', async () => {
    const report = await provisionRoles(admin, base);
    expect(report.created).toEqual([`role ${base.migrator}`, `role ${base.runtime}`, `schema ${base.schema}`]);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.checks.length).toBeGreaterThanOrEqual(5);
  });

  it('lets the migrator build the schema and the runtime role work with what it built, nothing more', async () => {
    const migrator = await connect(base.migrator, base.migratorPassword);
    const runtime = await connect(base.runtime, base.runtimePassword);
    try {
      const table = `${migrator.escapeIdentifier(base.schema)}.ticket_like`;
      // Created after provisioning: the default privileges must cover it.
      await migrator.query(`create table ${table} (id serial primary key, subject text not null)`);

      await runtime.query(`insert into ${table} (subject) values ('written by the runtime role')`); // uses the sequence too
      expect((await runtime.query(`select subject from ${table}`)).rows[0].subject).toBe('written by the runtime role');
      await runtime.query(`update ${table} set subject = 'changed'`);
      await runtime.query(`delete from ${table}`);

      expect(await failureOf(runtime.query(`create table ${migrator.escapeIdentifier(base.schema)}.sneaky (id int)`))).toMatch(/permission denied/);
      expect(await failureOf(runtime.query(`alter table ${table} add column extra int`))).toMatch(/must be owner/);
      expect(await failureOf(runtime.query(`drop table ${table}`))).toMatch(/must be owner/);
      expect(await failureOf(runtime.query(`truncate ${table}`))).toMatch(/permission denied/);
      expect(await failureOf(runtime.query(`create schema ${runtime.escapeIdentifier(`x_${run}`)}`))).toMatch(/permission denied/);
      expect(await failureOf(runtime.query(`create role ${runtime.escapeIdentifier(`x_${run}`)}`))).toMatch(/permission denied/);
    } finally {
      await migrator.end();
      await runtime.end();
    }
  });

  it('can be repeated: nothing is created again and the passwords stay as they were', async () => {
    const report = await provisionRoles(admin, { ...base, migratorPassword: password(), runtimePassword: password() });
    expect(report.created).toEqual([]);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    await (await connect(base.runtime, base.runtimePassword)).end(); // the old password still works
  });

  it('changes the passwords only when asked to', async () => {
    const next = { ...base, runtimePassword: password(), migratorPassword: password(), rotatePasswords: true };
    await provisionRoles(admin, next);
    await (await connect(next.runtime, next.runtimePassword)).end();
    expect(await failureOf(connect(base.runtime, base.runtimePassword))).toMatch(/password authentication failed/);
    base.runtimePassword = next.runtimePassword;
    base.migratorPassword = next.migratorPassword;
  });

  it('takes over a schema that the project owner created earlier, with its tables, sequences and enums', async () => {
    const adopted: RoleSetup = { ...base, schema: adoptedSchema }; // the passwords as they are now, after the rotation above
    const schema = admin.escapeIdentifier(adopted.schema);
    await admin.query(`create schema ${schema}`);
    await admin.query(`create type ${schema}.mood as enum ('ok', 'bad')`);
    await admin.query(`create table ${schema}.old_table (id serial primary key, mood ${schema}.mood)`);

    const report = await provisionRoles(admin, adopted);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    const owners = await admin.query(
      `select c.relname, pg_get_userbyid(c.relowner) as owner from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = $1 and c.relkind in ('r', 'S') order by 1`,
      [adopted.schema],
    );
    expect(owners.rows).toHaveLength(2); // the table and its sequence
    expect(owners.rows.every((r: { owner: string }) => r.owner === adopted.migrator)).toBe(true);
    const type = await admin.query(`select pg_get_userbyid(typowner) as owner from pg_type where typname = 'mood' and typnamespace = $1::regnamespace`, [adopted.schema]);
    expect(type.rows[0].owner).toBe(adopted.migrator);

    const runtime = await connect(adopted.runtime, adopted.runtimePassword);
    try {
      await runtime.query(`insert into ${schema}.old_table (mood) values ('ok')`);
    } finally {
      await runtime.end();
    }
  });
});

describe('role setup validation', () => {
  it('refuses unsafe names, equal roles, short and equal passwords', () => {
    expect(() => validateSetup({ ...base, schema: 'Support; drop table x' })).toThrow(/schema name/);
    expect(() => validateSetup({ ...base, runtime: base.migrator })).toThrow(/different roles/);
    expect(() => validateSetup({ ...base, runtimePassword: 'short' })).toThrow(/at least 24/);
    expect(() => validateSetup({ ...base, runtimePassword: base.migratorPassword })).toThrow(/different/);
    expect(() => validateSetup(base)).not.toThrow();
  });
});
