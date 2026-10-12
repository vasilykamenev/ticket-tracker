import { describe, expect, it } from 'vitest';
import { poolConfig } from '../../src/auth/session.js';

const URL_WITH_PARAMS = 'postgresql://app_runtime.ref:secret@aws-0-eu.pooler.supabase.com:5432/postgres?schema=support&sslmode=require&connection_limit=5&pgbouncer=true';

describe('session pool configuration', () => {
  it('drops the Prisma-only parameters and leaves the rest of the URL to node-postgres', () => {
    const config = poolConfig(URL_WITH_PARAMS);
    const url = new URL(config.connectionString!);
    expect([...url.searchParams.keys()]).toEqual(['sslmode']);
    expect(config.ssl).toBeUndefined();
    expect(config.max).toBe(5);
  });

  it('verifies the server against the given CA, and no sslmode in the URL can override that', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
    const config = poolConfig(URL_WITH_PARAMS, pem);
    expect(config.ssl).toEqual({ ca: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----', rejectUnauthorized: true });
    const url = new URL(config.connectionString!);
    expect([...url.searchParams.keys()]).toEqual([]);
    expect(url.username).toBe('app_runtime.ref');
  });

  it('keeps a plain local URL as it is', () => {
    expect(poolConfig('postgresql://postgres:postgres@localhost:5432/tickets?schema=support').connectionString).toBe('postgresql://postgres:postgres@localhost:5432/tickets');
  });
});
