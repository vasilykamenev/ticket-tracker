import connectPgSimple from 'connect-pg-simple';
import session from 'express-session';
import pg from 'pg';
import type { RequestHandler } from 'express';
import type { Env } from '../config/env.js';

/** URL parameters that only Prisma understands; node-postgres has no use for them. */
const PRISMA_ONLY_PARAMS = ['schema', 'connection_limit', 'pool_timeout', 'pgbouncer', 'sslaccept', 'socket_timeout', 'connect_timeout'];

/**
 * Connection settings of the session store's pool. With a CA certificate (DATABASE_CA_CERT) the server is verified
 * against it: node-postgres treats `sslmode=require` as full verification against the system roots, which does not
 * contain a managed provider's own CA (Supabase), and a sslmode left in the URL would override the explicit `ssl` setting.
 */
export function poolConfig(databaseUrl: string, caCert?: string): pg.PoolConfig {
  const url = new URL(databaseUrl);
  for (const key of PRISMA_ONLY_PARAMS) url.searchParams.delete(key);
  if (!caCert) return { connectionString: url.toString(), max: 5 };
  for (const key of ['sslmode', 'uselibpqcompat', 'sslrootcert']) url.searchParams.delete(key);
  // A single-line environment variable carries the line breaks of the PEM text as the two characters \n.
  const ca = caCert.replaceAll(String.raw`\n`, '\n');
  return { connectionString: url.toString(), max: 5, ssl: { ca, rejectUnauthorized: true } };
}

export function createSessionPool(env: Env): pg.Pool {
  return new pg.Pool(poolConfig(env.DATABASE_URL, env.DATABASE_CA_CERT));
}

export function createSessionMiddleware(env: Env, pool: pg.Pool): RequestHandler {
  const PgStore = connectPgSimple(session);
  return session({
    store: new PgStore({
      pool,
      schemaName: 'support',
      tableName: 'Session',
      createTableIfMissing: false, // the table is owned by Prisma migrations
      pruneSessionInterval: env.APP_ENV === 'test' ? false : 15 * 60,
    }),
    name: 'sid',
    secret: env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true, // idle timeout: the cookie and store expiry slide on every request
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.APP_ENV === 'production',
      maxAge: env.SESSION_IDLE_MINUTES * 60 * 1000,
    },
  });
}
