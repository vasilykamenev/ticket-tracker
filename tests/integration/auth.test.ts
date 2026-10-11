import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';
import { createSessionPool } from '../../src/auth/session.js';
import { loadEnv } from '../../src/config/env.js';
import { MemoryStorage } from '../../src/storage/memory-storage.js';
import type { Env } from '../../src/config/env.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests (see .env.example)');

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'Correct-Horse-9!';
const run = randomUUID().slice(0, 8);
const email = (name: string) => `${name}-${run}@example.test`;

const baseEnv = {
  APP_ENV: 'test',
  PUBLIC_URL: ORIGIN,
  DATABASE_URL: databaseUrl,
  SESSION_SECRET: 'integration-test-secret-integration-test',
  LOGIN_MAX_PER_IP: '1000',
  LOGIN_MAX_FAILED_PER_ACCOUNT: '1000',
};

const prisma = new PrismaClient();
const pool = createSessionPool(loadEnv(baseEnv));
const apps: express.Express[] = [];
const userIds: string[] = [];

async function makeApp(overrides: Record<string, string> = {}): Promise<express.Express> {
  const env: Env = loadEnv({ ...baseEnv, ...overrides });
  const app = await buildApp({ env, prisma, sessionPool: pool, storage: new MemoryStorage() });
  apps.push(app);
  return app;
}

async function createUser(name: string, opts: { role?: 'ADMIN' | 'AGENT'; isActive?: boolean; agentActive?: boolean | null }) {
  const role = opts.role ?? 'ADMIN';
  const user = await prisma.user.create({
    data: {
      normalizedEmail: email(name),
      displayName: name,
      passwordHash: await hashPassword(PASSWORD),
      role,
      isActive: opts.isActive ?? true,
      ...(opts.agentActive === null || opts.agentActive === undefined
        ? {}
        : { agent: { create: { displayName: name, isActive: opts.agentActive } } }),
    },
  });
  userIds.push(user.id);
  return user;
}

const csrfFrom = (html: string) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';

async function login(app: express.Express, who: string, password = PASSWORD) {
  const agent = request.agent(app);
  const page = await agent.get('/auth/login');
  const res = await agent
    .post('/auth/login')
    .set('Origin', ORIGIN)
    .type('form')
    .send({ _csrf: csrfFrom(page.text), email: email(who), password });
  return { agent, res };
}

const customersList = '/admin/api/resources/Customer/actions/list';

let app: express.Express;

beforeAll(async () => {
  app = await makeApp();
  await createUser('admin', { role: 'ADMIN' });
  await createUser('agent', { role: 'AGENT', agentActive: true });
  await createUser('agent-noprofile', { role: 'AGENT' });
  await createUser('agent-inactiveprofile', { role: 'AGENT', agentActive: false });
  await createUser('inactive', { role: 'ADMIN', isActive: false });
  await createUser('revoked', { role: 'ADMIN' });
  await createUser('expired', { role: 'ADMIN' });
  await createUser('versioned', { role: 'ADMIN' });
});

afterAll(async () => {
  await pool.query(`DELETE FROM support."Session" WHERE sess->>'userId' = ANY($1::text[])`, [userIds]);
  await prisma.agent.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
  await pool.end();
});

describe('health', () => {
  it('does not create sessions for probes', async () => {
    const live = await request(app).get('/health/live').expect(200);
    expect(live.headers['set-cookie']).toBeUndefined();
    await request(app).get('/health/ready').expect(200);
  });
});

describe('root address', () => {
  it('sends the bare address to the admin panel without creating a session', async () => {
    const res = await request(app).get('/').redirects(0).expect(302);
    expect(res.headers.location).toBe('/admin');
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('login', () => {
  it('serves a form with a CSRF token and a hardened session cookie', async () => {
    const res = await request(app).get('/auth/login').expect(200);
    expect(csrfFrom(res.text)).not.toBe('');
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('rejects a login without a CSRF token', async () => {
    await request(app)
      .post('/auth/login')
      .set('Origin', ORIGIN)
      .type('form')
      .send({ email: email('admin'), password: PASSWORD })
      .expect(403);
  });

  it('rejects a login from a foreign origin', async () => {
    const agent = request.agent(app);
    const page = await agent.get('/auth/login');
    await agent
      .post('/auth/login')
      .set('Origin', 'http://evil.test')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), email: email('admin'), password: PASSWORD })
      .expect(403);
  });

  it('gives the same answer for an unknown email and a wrong password', async () => {
    const strip = (html: string) => html.replace(/value="[^"]{20,}"/, '');
    const unknown = await login(app, 'nobody', PASSWORD);
    const wrong = await login(app, 'admin', 'wrong-password');
    expect(unknown.res.status).toBe(401);
    expect(wrong.res.status).toBe(401);
    expect(strip(unknown.res.text)).toBe(strip(wrong.res.text));
  });

  it('refuses inactive users and agents without an active profile', async () => {
    for (const who of ['inactive', 'agent-noprofile', 'agent-inactiveprofile']) {
      expect((await login(app, who)).res.status).toBe(401);
    }
  });

  it('signs in, rotates the session id and redirects to /admin', async () => {
    const agent = request.agent(app);
    const page = await agent.get('/auth/login');
    const before = String(page.headers['set-cookie']);
    const res = await agent
      .post('/auth/login')
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: csrfFrom(page.text), email: email('admin'), password: PASSWORD });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/admin');
    expect(String(res.headers['set-cookie'])).not.toBe(before);
    await agent.get(customersList).expect(200);
  });

  it('lets an active AGENT sign in', async () => {
    const { res } = await login(app, 'agent');
    expect(res.status).toBe(303);
  });
});

describe('protected admin', () => {
  it('returns 401 JSON for anonymous API calls and redirects page loads', async () => {
    await request(app).get(customersList).expect(401);
    const page = await request(app).get('/admin').expect(302);
    expect(page.headers.location).toBe('/auth/login');
  });

  it('rejects state-changing admin requests without the CSRF header', async () => {
    const { agent } = await login(app, 'admin');
    const url = `/admin/api/resources/Customer/records/${randomUUID()}/edit`;
    await agent.post(url).set('Origin', ORIGIN).send({}).expect(403);

    const { token } = (await agent.get('/auth/csrf')).body;
    const ok = await agent.post(url).set('Origin', ORIGIN).set('X-CSRF-Token', token).send({});
    expect([401, 403]).not.toContain(ok.status);
  });

  it('refuses the CSRF token endpoint to cross-site requests', async () => {
    const { agent } = await login(app, 'admin');
    await agent.get('/auth/csrf').set('Sec-Fetch-Site', 'cross-site').expect(403);
    const same = await agent.get('/auth/csrf').set('Sec-Fetch-Site', 'same-origin').expect(200);
    expect(same.headers['cache-control']).toBe('no-store');
  });
});

describe('logout', () => {
  it('does not mutate on GET and requires a token on POST', async () => {
    const { agent } = await login(app, 'admin');
    const confirm = await agent.get('/auth/logout').expect(200);
    await agent.get(customersList).expect(200); // still signed in after GET
    await agent.post('/auth/logout').set('Origin', ORIGIN).expect(403);
    await agent.get(customersList).expect(200);

    await agent
      .post('/auth/logout')
      .set('Origin', ORIGIN)
      .type('form')
      .send({ _csrf: csrfFrom(confirm.text) })
      .expect(303);
    await agent.get(customersList).expect(401);
  });
});

describe('session revocation', () => {
  it('invalidates the session when sessionVersion changes', async () => {
    const { agent } = await login(app, 'versioned');
    await agent.get(customersList).expect(200);
    await prisma.user.update({ where: { normalizedEmail: email('versioned') }, data: { sessionVersion: { increment: 1 } } });
    await agent.get(customersList).expect(401);
  });

  it('invalidates the session when the user is deactivated', async () => {
    const { agent } = await login(app, 'revoked');
    await agent.get(customersList).expect(200);
    await prisma.user.update({ where: { normalizedEmail: email('revoked') }, data: { isActive: false } });
    await agent.get(customersList).expect(401);
  });

  it('enforces the absolute lifetime even while the session is active', async () => {
    const { agent } = await login(app, 'expired');
    await agent.get(customersList).expect(200);
    const user = await prisma.user.findUniqueOrThrow({ where: { normalizedEmail: email('expired') } });
    await pool.query(
      `UPDATE support."Session" SET sess = jsonb_set(sess::jsonb, '{authAt}', '1'::jsonb)::json WHERE sess->>'userId' = $1`,
      [user.id],
    );
    await agent.get(customersList).expect(401);
  });
});

describe('rate limiting', () => {
  it('locks an account after repeated failures, even for the right password', async () => {
    const limited = await makeApp({ LOGIN_MAX_FAILED_PER_ACCOUNT: '2' });
    expect((await login(limited, 'admin', 'bad-1')).res.status).toBe(401);
    expect((await login(limited, 'admin', 'bad-2')).res.status).toBe(401);
    expect((await login(limited, 'admin', PASSWORD)).res.status).toBe(429);
  });

  it('limits attempts per IP', async () => {
    const limited = await makeApp({ LOGIN_MAX_PER_IP: '2' });
    await login(limited, 'nobody-a');
    await login(limited, 'nobody-b');
    expect((await login(limited, 'nobody-c')).res.status).toBe(429);
  });
});
