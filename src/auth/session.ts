import connectPgSimple from 'connect-pg-simple';
import session from 'express-session';
import pg from 'pg';
import type { RequestHandler } from 'express';
import type { Env } from '../config/env.js';

/** Prisma accepts `?schema=`; node-postgres does not need it, so strip it. */
function poolConfig(databaseUrl: string): pg.PoolConfig {
  const url = new URL(databaseUrl);
  url.searchParams.delete('schema');
  return { connectionString: url.toString(), max: 5 };
}

export function createSessionPool(env: Env): pg.Pool {
  return new pg.Pool(poolConfig(env.DATABASE_URL));
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
