import type { PrismaClient } from '@prisma/client';
import type express from 'express';
import request from 'supertest';
import { expect } from 'vitest';
import { buildApp } from '../../../src/app.js';
import { createSessionPool } from '../../../src/auth/session.js';
import { loadEnv } from '../../../src/config/env.js';
import { MemoryStorage } from '../../../src/storage/memory-storage.js';
import { TEST_PASSWORD } from './fixtures.js';

export const ORIGIN = 'http://localhost:3000';
export const API = '/admin/api/resources';

export function testEnv(overrides: Record<string, string> = {}) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests (see .env.example)');
  return loadEnv({
    APP_ENV: 'test',
    PUBLIC_URL: ORIGIN,
    DATABASE_URL: databaseUrl,
    SESSION_SECRET: 'integration-test-secret-integration-test',
    LOGIN_MAX_PER_IP: '1000',
    LOGIN_MAX_FAILED_PER_ACCOUNT: '1000',
    ...overrides,
  });
}

export async function createTestApp(prisma: PrismaClient, options: { env?: Record<string, string>; storage?: MemoryStorage } = {}) {
  const env = testEnv(options.env);
  const pool = createSessionPool(env);
  const storage = options.storage ?? new MemoryStorage();
  const app: express.Express = await buildApp({ env, prisma, sessionPool: pool, storage });
  return { app, pool, storage };
}

const csrfFrom = (html: string) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';

/** A signed-in session: GET helper plus a POST helper that carries Origin and the CSRF header. */
export async function signIn(app: express.Express, email: string) {
  const agent = request.agent(app);
  const page = await agent.get('/auth/login');
  const res = await agent.post('/auth/login').set('Origin', ORIGIN).type('form').send({ _csrf: csrfFrom(page.text), email, password: TEST_PASSWORD });
  expect(res.status).toBe(303);
  const { token } = (await agent.get('/auth/csrf')).body as { token: string };
  return {
    get: (url: string) => agent.get(url),
    post: (url: string, body: object = {}) => agent.post(url).set('Origin', ORIGIN).set('X-CSRF-Token', token).send(body),
    /** A request that carries Origin and the CSRF header but whose body the caller builds (multipart, DELETE). */
    with: (method: 'post' | 'delete', url: string) => agent[method](url).set('Origin', ORIGIN).set('X-CSRF-Token', token),
    /** The same session without the CSRF header, to prove it is required. */
    withoutToken: (method: 'post' | 'delete', url: string) => agent[method](url).set('Origin', ORIGIN),
  };
}
export type Session = Awaited<ReturnType<typeof signIn>>;
