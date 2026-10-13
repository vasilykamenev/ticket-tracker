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

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests (see .env.example)');

const ORIGIN = 'http://localhost:3000';
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
const bothProviders = { GOOGLE_CLIENT_ID: 'g-id', GOOGLE_CLIENT_SECRET: 'g-secret', GITHUB_CLIENT_ID: 'h-id', GITHUB_CLIENT_SECRET: 'h-secret' };

const prisma = new PrismaClient();
const pool = createSessionPool(loadEnv(baseEnv));
const userIds: string[] = [];

/** What the providers answer; each test sets the e-mail the "person" has at Google or GitHub. */
const provider = {
  googleEmail: null as string | null,
  googleVerified: true,
  githubEmails: [] as Array<{ email: string; primary: boolean; verified: boolean }>,
  tokenOk: true,
  calls: [] as Array<{ url: string; body: string }>,
};

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

async function fakeFetch(url: string, init?: RequestInit): Promise<Response> {
  provider.calls.push({ url, body: String(init?.body ?? '') });
  if (url === 'https://oauth2.googleapis.com/token' || url === 'https://github.com/login/oauth/access_token') {
    return provider.tokenOk ? json({ access_token: 'token-1', token_type: 'bearer' }) : json({ error: 'bad_verification_code' }, 400);
  }
  if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return json({ email: provider.googleEmail, email_verified: provider.googleVerified });
  if (url === 'https://api.github.com/user/emails') return json(provider.githubEmails);
  throw new Error(`unexpected request to ${url}`);
}

async function makeApp(overrides: Record<string, string> = bothProviders): Promise<express.Express> {
  return buildApp({ env: loadEnv({ ...baseEnv, ...overrides }), prisma, sessionPool: pool, storage: new MemoryStorage(), oauthFetch: fakeFetch });
}

async function createUser(name: string, opts: { role?: 'ADMIN' | 'AGENT'; isActive?: boolean; agentActive?: boolean } = {}) {
  const role = opts.role ?? 'ADMIN';
  const user = await prisma.user.create({
    data: {
      normalizedEmail: email(name),
      displayName: name,
      passwordHash: await hashPassword('Correct-Horse-9!'),
      role,
      isActive: opts.isActive ?? true,
      ...(role === 'AGENT' ? { agent: { create: { displayName: name, isActive: opts.agentActive ?? true } } } : {}),
    },
  });
  userIds.push(user.id);
  return user;
}

/** Starts the flow and returns the agent holding the session, plus what was sent to the provider. */
async function start(app: express.Express, id: 'google' | 'github') {
  const agent = request.agent(app);
  const res = await agent.get(`/auth/oauth/${id}`).redirects(0).expect(302);
  const location = new URL(res.headers.location as string);
  return { agent, location, state: location.searchParams.get('state') ?? '' };
}

const callback = (agent: ReturnType<typeof request.agent>, id: 'google' | 'github', query: string) => agent.get(`/auth/oauth/${id}/callback?${query}`).redirects(0);

let app: express.Express;

beforeAll(async () => {
  app = await makeApp();
  await createUser('oa-admin', { role: 'ADMIN' });
  await createUser('oa-agent', { role: 'AGENT' });
  await createUser('oa-inactive', { role: 'ADMIN', isActive: false });
  await createUser('oa-noprofile-agent', { role: 'AGENT', agentActive: false });
});

afterAll(async () => {
  await pool.query(`DELETE FROM support."Session" WHERE sess->>'userId' = ANY($1::text[])`, [userIds]);
  await prisma.agent.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
  await pool.end();
});

describe('configuration', () => {
  it('shows a button only for a configured provider', async () => {
    const both = (await request(app).get('/auth/login').expect(200)).text;
    expect(both).toContain('/auth/oauth/google');
    expect(both).toContain('/auth/oauth/github');

    const none = await makeApp({});
    const html = (await request(none).get('/auth/login').expect(200)).text;
    expect(html).not.toContain('/auth/oauth/');
    await request(none).get('/auth/oauth/google').redirects(0).expect(404);

    const onlyGithub = await makeApp({ GITHUB_CLIENT_ID: 'h-id', GITHUB_CLIENT_SECRET: 'h-secret' });
    const gh = (await request(onlyGithub).get('/auth/login').expect(200)).text;
    expect(gh).toContain('/auth/oauth/github');
    expect(gh).not.toContain('/auth/oauth/google');
  });

  it('refuses a client id without its secret', () => {
    expect(() => loadEnv({ ...baseEnv, GOOGLE_CLIENT_ID: 'only-id' })).toThrow(/GOOGLE_CLIENT_SECRET/);
    expect(() => loadEnv({ ...baseEnv, GITHUB_CLIENT_SECRET: 'only-secret' })).toThrow(/GITHUB_CLIENT_ID/);
  });
});

describe('the redirect to the provider', () => {
  it('carries a state, a PKCE challenge and the callback address, and never the secret', async () => {
    const { location, state } = await start(app, 'google');
    expect(location.origin + location.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(location.searchParams.get('client_id')).toBe('g-id');
    expect(location.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/auth/oauth/google/callback`);
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    expect(state.length).toBeGreaterThanOrEqual(30);
    expect(location.toString()).not.toContain('g-secret');
  });

  it('uses a different state every time', async () => {
    const a = await start(app, 'github');
    const b = await start(app, 'github');
    expect(a.state).not.toBe(b.state);
  });
});

describe('the callback', () => {
  it('signs in an existing active user by the verified e-mail of Google, and starts a new session', async () => {
    provider.googleEmail = email('oa-admin').toUpperCase();
    provider.googleVerified = true;
    provider.calls = [];
    const { agent, state } = await start(app, 'google');
    const res = await callback(agent, 'google', `code=abc&state=${state}`).expect(303);
    expect(res.headers.location).toBe('/app');
    expect(String(res.headers['set-cookie'])).toMatch(/sid=/);
    // The code goes to the token endpoint together with the PKCE verifier and the secret, never through the browser.
    const exchange = provider.calls.find((c) => c.url === 'https://oauth2.googleapis.com/token')!;
    expect(exchange.body).toContain('code_verifier=');
    expect(exchange.body).toContain('client_secret=g-secret');
    await agent.get('/app/api/resources/Customer/actions/list').expect(200);
  });

  it('signs in an agent too, and the role is the one stored for the account', async () => {
    provider.googleEmail = email('oa-agent');
    const { agent, state } = await start(app, 'google');
    await callback(agent, 'google', `code=abc&state=${state}`).expect(303);
    const users = await agent.get('/app/api/resources/User/actions/list');
    expect(JSON.stringify(users.body)).toContain('ForbiddenError'); // an agent cannot list users: the stored role applies
  });

  it('uses only the primary verified address at GitHub', async () => {
    provider.githubEmails = [
      { email: email('oa-admin'), primary: false, verified: true },
      { email: 'someone-else@example.test', primary: true, verified: true },
    ];
    const first = await start(app, 'github');
    await callback(first.agent, 'github', `code=abc&state=${first.state}`).expect(401); // the matching address is not the primary one

    provider.githubEmails = [{ email: email('oa-admin'), primary: true, verified: true }];
    const second = await start(app, 'github');
    await callback(second.agent, 'github', `code=abc&state=${second.state}`).expect(303);
  });

  it('refuses an unverified address', async () => {
    provider.googleEmail = email('oa-admin');
    provider.googleVerified = false;
    const { agent, state } = await start(app, 'google');
    await callback(agent, 'google', `code=abc&state=${state}`).expect(401);
    await agent.get('/app/api/resources/Customer/actions/list').expect(401);
    provider.githubEmails = [{ email: email('oa-admin'), primary: true, verified: false }];
    const gh = await start(app, 'github');
    await callback(gh.agent, 'github', `code=abc&state=${gh.state}`).expect(401);
  });

  it('refuses an address that has no account, an inactive user and an agent without an active profile, with the same message', async () => {
    provider.googleVerified = true;
    const messages = new Set<string>();
    for (const who of [`stranger-${run}@example.test`, email('oa-inactive'), email('oa-noprofile-agent')]) {
      provider.googleEmail = who;
      const { agent, state } = await start(app, 'google');
      const res = await callback(agent, 'google', `code=abc&state=${state}`).expect(401);
      messages.add(/role="alert">([^<]*)</.exec(res.text)?.[1] ?? '');
    }
    expect(messages.size).toBe(1);
    // Nothing was created for the stranger.
    expect(await prisma.user.findUnique({ where: { normalizedEmail: `stranger-${run}@example.test` } })).toBeNull();
  });

  it('refuses a wrong or missing state, and a state that was already used', async () => {
    provider.googleEmail = email('oa-admin');
    provider.googleVerified = true;
    const wrong = await start(app, 'google');
    await callback(wrong.agent, 'google', 'code=abc&state=nope').expect(401);

    const missing = await start(app, 'google');
    await callback(missing.agent, 'google', 'code=abc').expect(401);

    const used = await start(app, 'google');
    await callback(used.agent, 'google', `code=abc&state=${used.state}`).expect(303);
    // Replaying the same callback in a new session of the same browser: nothing is pending any more.
    const replay = request.agent(app);
    await callback(replay, 'google', `code=abc&state=${used.state}`).expect(401);
  });

  it('refuses a callback that no flow started, and one that belongs to another provider', async () => {
    await callback(request.agent(app), 'google', 'code=abc&state=anything').expect(401);
    provider.githubEmails = [{ email: email('oa-admin'), primary: true, verified: true }];
    const g = await start(app, 'google');
    await callback(g.agent, 'github', `code=abc&state=${g.state}`).expect(401);
  });

  it('refuses when the provider rejects the code or an error comes back', async () => {
    provider.googleEmail = email('oa-admin');
    provider.tokenOk = false;
    try {
      const { agent, state } = await start(app, 'google');
      await callback(agent, 'google', `code=abc&state=${state}`).expect(401);
    } finally {
      provider.tokenOk = true;
    }
    const denied = await start(app, 'google');
    await callback(denied.agent, 'google', `error=access_denied&state=${denied.state}`).expect(401);
  });

  it('does not let a deactivated user back in through the provider', async () => {
    const user = await createUser('oa-later-inactive');
    provider.googleEmail = email('oa-later-inactive');
    const ok = await start(app, 'google');
    await callback(ok.agent, 'google', `code=abc&state=${ok.state}`).expect(303);
    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
    // The session that was just opened ends on the next request, and a new attempt is refused.
    await ok.agent.get('/app/api/resources/Customer/actions/list').expect(401);
    const again = await start(app, 'google');
    await callback(again.agent, 'google', `code=abc&state=${again.state}`).expect(401);
  });
});
