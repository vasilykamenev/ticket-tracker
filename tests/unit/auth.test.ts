import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { csrfProtection, ensureCsrfToken } from '../../src/auth/csrf.js';
import { hashPassword, verifyPassword } from '../../src/auth/password.js';
import { loadEnv } from '../../src/config/env.js';
import { normalizeEmail } from '../../src/domain/users/email.js';

describe('password hashing', () => {
  it('uses argon2id and verifies only the right password', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
  });

  it('treats a malformed hash as a failed verification', async () => {
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });
});

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Admin@Example.TEST ')).toBe('admin@example.test');
  });
});

describe('loadEnv', () => {
  const base = {
    PUBLIC_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    SESSION_SECRET: 'x'.repeat(32),
  };

  it('applies defaults', () => {
    const env = loadEnv(base);
    expect(env.SESSION_IDLE_MINUTES).toBe(30);
    expect(env.SESSION_ABSOLUTE_HOURS).toBe(8);
  });

  it('rejects a short session secret without echoing it', () => {
    expect(() => loadEnv({ ...base, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
    expect(() => loadEnv({ ...base, SESSION_SECRET: 'short' })).not.toThrow(/short'/);
  });

  it('requires https and a real secret in production', () => {
    expect(() => loadEnv({ ...base, APP_ENV: 'production' })).toThrow(/PUBLIC_URL/);
    expect(() =>
      loadEnv({ ...base, APP_ENV: 'production', PUBLIC_URL: 'https://x.test', SESSION_SECRET: 'CHANGE_ME'.padEnd(40, 'x') }),
    ).toThrow(/SESSION_SECRET/);
  });
});

describe('csrfProtection', () => {
  const origin = 'http://localhost:3000';
  const app = express();
  app.use(session({ secret: 'test-secret-test-secret-test-secret', resave: false, saveUninitialized: false }));
  app.use(express.urlencoded({ extended: false }));
  app.get('/token', (req, res) => {
    res.json({ token: ensureCsrfToken(req) });
  });
  app.use(csrfProtection(origin));
  app.get('/read', (_req, res) => {
    res.send('ok');
  });
  app.post('/write', (_req, res) => {
    res.send('written');
  });

  it('lets safe methods through without a token', async () => {
    await request(app).get('/read').expect(200);
  });

  it('rejects an unsafe request without a token', async () => {
    const agent = request.agent(app);
    await agent.get('/token');
    await agent.post('/write').set('Origin', origin).expect(403);
  });

  it('rejects a wrong token and a wrong origin', async () => {
    const agent = request.agent(app);
    const { token } = (await agent.get('/token')).body;
    await agent.post('/write').set('Origin', origin).set('X-CSRF-Token', 'nope').expect(403);
    await agent.post('/write').set('Origin', 'http://evil.test').set('X-CSRF-Token', token).expect(403);
    await agent.post('/write').set('X-CSRF-Token', token).expect(403); // missing Origin
  });

  it('accepts the token from a header or a form field', async () => {
    const agent = request.agent(app);
    const { token } = (await agent.get('/token')).body;
    await agent.post('/write').set('Origin', origin).set('X-CSRF-Token', token).expect(200);
    await agent.post('/write').set('Origin', origin).type('form').send({ _csrf: token }).expect(200);
  });
});
