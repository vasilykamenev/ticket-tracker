import type { PrismaClient } from '@prisma/client';
import type express from 'express';
import request from 'supertest';
import { expect } from 'vitest';
import { buildApp } from '../../../src/app.js';
import { createSessionPool } from '../../../src/auth/session.js';
import { loadEnv } from '../../../src/config/env.js';
import { TEST_PASSWORD } from './fixtures.js';

export const ORIGIN = 'http://localhost:3000';
export const API = '/admin/api/resources';

export function testEnv() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests (see .env.example)');
  return loadEnv({
    APP_ENV: 'test',
    PUBLIC_URL: ORIGIN,
    DATABASE_URL: databaseUrl,
    SESSION_SECRET: 'integration-test-secret-integration-test',
    LOGIN_MAX_PER_IP: '1000',
    LOGIN_MAX_FAILED_PER_ACCOUNT: '1000',
  });
}

export async function createTestApp(prisma: PrismaClient) {
  const env = testEnv();
  const pool = createSessionPool(env);
  const app: express.Express = await buildApp({ env, prisma, sessionPool: pool });
  return { app, pool };
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
  };
}
export type Session = Awaited<ReturnType<typeof signIn>>;
