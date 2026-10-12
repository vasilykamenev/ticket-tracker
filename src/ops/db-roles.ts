import pg from 'pg';

/**
 * Database roles for a deployment (requirements section 9, item 10): the application connects with a runtime role
 * that does not own the schema and cannot run DDL, and the migration credentials belong to a separate role that
 * only the migration step has. This module creates both roles and the schema, and checks the result.
 */

export interface RoleSetup {
  schema: string;
  /** Owns the schema and everything in it; used only by `prisma migrate deploy`. */
  migrator: string;
  /** What the application connects as: reads and writes rows, nothing else. */
  runtime: string;
  migratorPassword: string;
  runtimePassword: string;
  /** Change the passwords of roles that already exist (otherwise they are left alone). */
  rotatePasswords?: boolean;
}

export const MIN_ROLE_PASSWORD_LENGTH = 24;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
/** Roles Supabase creates for its Data API: they must have no access to the application's schema. */
const SUPABASE_API_ROLES = ['anon', 'authenticated', 'service_role'];

export function validateSetup(setup: RoleSetup): void {
  for (const [what, value] of [['schema', setup.schema], ['migrator', setup.migrator], ['runtime', setup.runtime]] as const) {
    if (!IDENTIFIER.test(value)) throw new Error(`The ${what} name must be lowercase letters, digits and underscores (got "${value}").`);
  }
  if (setup.migrator === setup.runtime) throw new Error('The migrator and the runtime role must be different roles.');
  for (const [what, value] of [['migrator', setup.migratorPassword], ['runtime', setup.runtimePassword]] as const) {
    if (value.length < MIN_ROLE_PASSWORD_LENGTH) throw new Error(`The ${what} password must be at least ${MIN_ROLE_PASSWORD_LENGTH} characters.`);
  }
  if (setup.migratorPassword === setup.runtimePassword) throw new Error('The two passwords must be different.');
}

export interface ProvisionReport {
  created: string[];
  checks: Array<{ check: string; ok: boolean }>;
  warnings: string[];
}

/** Runs with a role that may create roles and schemas (the project owner, `postgres` on Supabase). Safe to repeat. */
export async function provisionRoles(admin: pg.Client, setup: RoleSetup): Promise<ProvisionReport> {
  validateSetup(setup);
  const id = (name: string) => admin.escapeIdentifier(name);
  const report: ProvisionReport = { created: [], checks: [], warnings: [] };
  const run = (sql: string) => admin.query(sql);
  const roleExists = async (name: string) => (await admin.query('select 1 from pg_roles where rolname = $1', [name])).rowCount === 1;
  const database = (await admin.query('select current_database() as name')).rows[0].name as string;

  for (const [name, password] of [[setup.migrator, setup.migratorPassword], [setup.runtime, setup.runtimePassword]] as const) {
    if (!(await roleExists(name))) {
      await run(`create role ${id(name)} login password ${admin.escapeLiteral(password)}`);
      report.created.push(`role ${name}`);
    } else if (setup.rotatePasswords) {
      await run(`alter role ${id(name)} password ${admin.escapeLiteral(password)}`);
      report.created.push(`new password for ${name}`);
    }
  }
  // Supabase's owner is not a superuser, so it can only hand out a role it is a member of.
  await run(`grant ${id(setup.migrator)} to current_user`).catch(() => undefined);
  await run(`grant create on database ${id(database)} to ${id(setup.migrator)}`);

  const schemaExists = (await admin.query('select 1 from pg_namespace where nspname = $1', [setup.schema])).rowCount === 1;
  if (!schemaExists) {
    await run(`create schema ${id(setup.schema)} authorization ${id(setup.migrator)}`);
    report.created.push(`schema ${setup.schema}`);
  } else {
    // A schema that was created earlier by the project owner: hand it and its contents to the migrator.
    await run(`alter schema ${id(setup.schema)} owner to ${id(setup.migrator)}`);
    await run(`
      do $$
      declare item record;
      begin
        for item in
          select c.oid::regclass as name, case c.relkind when 'S' then 'sequence' when 'v' then 'view' else 'table' end as kind
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = ${admin.escapeLiteral(setup.schema)} and c.relkind in ('r', 'p', 'S', 'v')
            and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype in ('a', 'i'))
        loop
          execute format('alter %s %s owner to %I', item.kind, item.name, ${admin.escapeLiteral(setup.migrator)});
        end loop;
        for item in
          select t.oid::regtype as name from pg_type t join pg_namespace n on n.oid = t.typnamespace
          where n.nspname = ${admin.escapeLiteral(setup.schema)} and t.typtype = 'e'
        loop
          execute format('alter type %s owner to %I', item.name, ${admin.escapeLiteral(setup.migrator)});
        end loop;
      end $$`);
  }

  // The runtime role: rows and sequences in the schema, nothing else, now and for everything the migrator creates later.
  const schema = id(setup.schema);
  const runtime = id(setup.runtime);
  await run(`grant usage on schema ${schema} to ${runtime}`);
  await run(`grant select, insert, update, delete on all tables in schema ${schema} to ${runtime}`);
  await run(`grant usage, select, update on all sequences in schema ${schema} to ${runtime}`);
  await run(`alter default privileges for role ${id(setup.migrator)} in schema ${schema} grant select, insert, update, delete on tables to ${runtime}`);
  await run(`alter default privileges for role ${id(setup.migrator)} in schema ${schema} grant usage, select, update on sequences to ${runtime}`);

  // Supabase's Data API roles must not reach the schema (the application is the only client).
  for (const role of SUPABASE_API_ROLES) {
    if (await roleExists(role)) {
      await run(`revoke all on all tables in schema ${schema} from ${id(role)}`);
      await run(`revoke all on all sequences in schema ${schema} from ${id(role)}`);
      await run(`revoke all on schema ${schema} from ${id(role)}`);
    }
  }

  await verifyRoles(admin, setup, report);
  return report;
}

async function verifyRoles(admin: pg.Client, setup: RoleSetup, report: ProvisionReport): Promise<void> {
  const one = async (sql: string, params: unknown[]) => (await admin.query(sql, params)).rows[0] as Record<string, boolean | string | null>;
  const check = (label: string, ok: boolean) => report.checks.push({ check: label, ok });

  const owner = await one('select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = $1', [setup.schema]);
  check(`the schema ${setup.schema} is owned by ${setup.migrator}`, owner.owner === setup.migrator);
  const rt = await one(
    `select has_schema_privilege($1, $2, 'USAGE') as usage, has_schema_privilege($1, $2, 'CREATE') as create_,
            (select rolsuper or rolcreaterole or rolcreatedb from pg_roles where rolname = $1) as powerful`,
    [setup.runtime, setup.schema],
  );
  check(`${setup.runtime} can use the schema`, rt.usage === true);
  check(`${setup.runtime} cannot create objects in the schema`, rt.create_ === false);
  check(`${setup.runtime} is not a superuser and cannot create roles or databases`, rt.powerful === false);
  const stray = await admin.query(
    `select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1 and c.relkind in ('r', 'p', 'S') and pg_get_userbyid(c.relowner) <> $2
       and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype in ('a', 'i'))`,
    [setup.schema, setup.migrator],
  );
  check(`every table and sequence in the schema belongs to ${setup.migrator}`, stray.rows[0].n === 0);

  for (const role of SUPABASE_API_ROLES) {
    const row = await admin.query(
      'select has_schema_privilege(r.rolname, $2, \'USAGE\') as usage from pg_roles r where r.rolname = $1',
      [role, setup.schema],
    );
    if (row.rowCount === 1) check(`${role} has no access to the schema`, row.rows[0].usage === false);
  }
  // The Data API exposes only the schemas listed in PostgREST's configuration.
  const exposed = await admin.query(
    `select unnest(setconfig) as setting from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
     where r.rolname = 'authenticator'`,
  ).catch(() => ({ rows: [] as Array<{ setting: string }> }));
  const listed = exposed.rows.map((r: { setting: string }) => r.setting).find((s: string) => s.startsWith('pgrst.db_schemas='));
  if (listed && listed.slice('pgrst.db_schemas='.length).split(',').map((s: string) => s.trim()).includes(setup.schema)) {
    report.warnings.push(`The Data API exposes the schema "${setup.schema}": remove it in Supabase, Settings, API, Exposed schemas.`);
  }
}
