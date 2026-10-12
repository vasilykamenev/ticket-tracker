import { PrismaClient } from '@prisma/client';
import type express from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AssistantUnavailableError, type AssistantProvider } from '../../src/assistant/provider.js';
import { Fixtures } from './helpers/fixtures.js';
import { ORIGIN, createTestApp, signIn } from './helpers/http.js';

const prisma = new PrismaClient();
const fx = new Fixtures(prisma);

/** What the provider was sent, and what it should do next. */
const sent: Array<{ system: string; user: string }> = [];
let behaviour: 'answer' | 'unavailable' = 'answer';
const provider: AssistantProvider = {
  async ask(system, user) {
    sent.push({ system, user });
    if (behaviour === 'unavailable') throw new AssistantUnavailableError('timeout');
    return 'Priority takes one of four values.';
  },
};

let on: { app: express.Express; pool: Pool };
let off: { app: express.Express; pool: Pool };
let admin: Awaited<ReturnType<Fixtures['admin']>>;
let agent: Awaited<ReturnType<Fixtures['agent']>>;
const ASK = { resourceId: 'Ticket', fieldId: 'priority', question: 'What can I choose here?' };

beforeAll(async () => {
  await fx.init();
  on = await createTestApp(prisma, { env: { AI_ENABLED: 'true', AI_PROVIDER: 'fake', AI_RATE_PER_MINUTE: '5' }, assistant: provider });
  off = await createTestApp(prisma);
  const group = await fx.group();
  admin = await fx.admin();
  agent = await fx.agent([group]);
});

afterAll(async () => {
  await on.pool.query(`DELETE FROM support."Session" WHERE sess->>'userId' = ANY($1::text[])`, [[admin.user.id, agent.user.id]]);
  await fx.cleanup();
  await prisma.$disconnect();
  await on.pool.end();
  await off.pool.end();
});

describe('AI help, disabled (the default)', () => {
  it('has no endpoint, no widget script, and the admin does not load one', async () => {
    const s = await signIn(off.app, agent.user.normalizedEmail);
    expect((await s.post('/internal/assistant', ASK)).status).toBe(404);
    expect((await s.get('/internal/assistant/fields?resourceId=Ticket')).status).toBe(404);
    expect((await request(off.app).get('/auth/assistant-widget.js')).status).toBe(404);
  });
});

describe('AI help, enabled', () => {
  it('serves the widget script, which holds no key and no endpoint secret', async () => {
    const res = await request(on.app).get('/auth/assistant-widget.js').expect(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.text).toMatch(/internal\/assistant/);
    expect(res.text).not.toMatch(/sk-ant|ANTHROPIC|api[-_ ]?key/i);
    // Answers are written as text, never as HTML.
    expect(res.text).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/);
  });

  it('refuses an anonymous request and a signed-in one without the CSRF header', async () => {
    // The CSRF check comes before authentication, so an anonymous POST is refused there; an anonymous GET reaches the login check.
    expect((await request(on.app).post('/internal/assistant').set('Origin', ORIGIN).send(ASK)).status).toBe(403);
    const s = await signIn(on.app, agent.user.normalizedEmail);
    expect((await s.withoutToken('post', '/internal/assistant').send(ASK)).status).toBe(403);
    expect((await request(on.app).get('/internal/assistant/fields?resourceId=Ticket')).status).toBe(401);
  });

  it('lists the fields of a screen for an agent, and refuses the screens an agent cannot open', async () => {
    const s = await signIn(on.app, agent.user.normalizedEmail);
    const ticket = await s.get('/internal/assistant/fields?resourceId=Ticket').expect(200);
    expect(ticket.headers['cache-control']).toBe('no-store');
    expect((ticket.body as { fields: Array<{ id: string }> }).fields.map((f) => f.id)).toContain('priority');
    for (const resource of ['User', 'SupportGroup', 'Agent', 'TicketStatus', 'Nope', '']) {
      expect((await s.get(`/internal/assistant/fields?resourceId=${resource}`)).status, resource).toBe(404);
    }
    const a = await signIn(on.app, admin.user.normalizedEmail);
    expect((await a.get('/internal/assistant/fields?resourceId=User')).status).toBe(200);
  });

  it('answers a question about a field, and sends the provider the catalog context only', async () => {
    sent.length = 0;
    behaviour = 'answer';
    const s = await signIn(on.app, agent.user.normalizedEmail);
    const res = await s.post('/internal/assistant', ASK).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ available: true, answer: 'Priority takes one of four values.', help: { label: 'Priority' } });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.user).toContain('"field": "priority"');
    expect(sent[0]!.user).toContain('"viewerRole": "AGENT"');
    expect(sent[0]!.user).not.toContain(agent.user.normalizedEmail);
    expect(sent[0]!.user).not.toContain(agent.user.id);
  });

  it('does not trust what the browser says about the form: an agent cannot ask about a screen of administrators', async () => {
    sent.length = 0;
    const s = await signIn(on.app, agent.user.normalizedEmail);
    expect((await s.post('/internal/assistant', { resourceId: 'User', fieldId: 'role', question: 'Who may change it?' })).status).toBe(404);
    expect((await s.post('/internal/assistant', { resourceId: 'Ticket', fieldId: 'passwordHash', question: 'x' })).status).toBe(404);
    expect(sent).toHaveLength(0);
    const a = await signIn(on.app, admin.user.normalizedEmail);
    expect((await a.post('/internal/assistant', { resourceId: 'User', fieldId: 'role', question: 'Who may change it?' })).status).toBe(200);
  });

  it('rejects a malformed request without calling the provider', async () => {
    sent.length = 0;
    const s = await signIn(on.app, agent.user.normalizedEmail);
    expect((await s.post('/internal/assistant', { ...ASK, question: '' })).status).toBe(422);
    expect((await s.post('/internal/assistant', { ...ASK, question: 'x'.repeat(1001) })).status).toBe(422);
    expect((await s.post('/internal/assistant', { ...ASK, extra: true })).status).toBe(422);
    expect((await s.with('post', '/internal/assistant').type('form').send('resourceId=Ticket')).status).toBe(422);
    expect((await s.with('post', '/internal/assistant').set('Content-Type', 'application/json').send('{not json')).status).toBe(422);
    expect((await s.with('post', '/internal/assistant').set('Content-Type', 'application/json').send(JSON.stringify({ ...ASK, question: 'x'.repeat(6000) }))).status).toBe(413);
    expect(sent).toHaveLength(0);
  });

  it('shows the static help, with a normal 200, when the provider cannot answer, and the rest of the admin still works', async () => {
    behaviour = 'unavailable';
    const s = await signIn(on.app, agent.user.normalizedEmail);
    const res = await s.post('/internal/assistant', ASK).expect(200);
    expect(res.body).toMatchObject({ available: false, answer: null });
    expect((res.body as { message: string }).message).toMatch(/not available/);
    expect((res.body as { help: { lines: string[] } }).help.lines.join(' ')).toMatch(/LOW, NORMAL, HIGH or URGENT/);
    expect((await s.get('/admin/api/resources/Ticket/actions/list')).status).toBe(200);
    behaviour = 'answer';
  });

  it('allows a limited number of questions a minute per person, then answers 429 with the help and Retry-After', async () => {
    behaviour = 'answer';
    const a = await signIn(on.app, admin.user.normalizedEmail);
    // The test app allows 5 a minute; this administrator has asked once above.
    let refused;
    for (let i = 0; i < 10 && !refused; i++) {
      const res = await a.post('/internal/assistant', ASK);
      if (res.status === 429) refused = res;
    }
    expect(refused).toBeDefined();
    expect(Number(refused!.headers['retry-after'])).toBeGreaterThan(0);
    expect(refused!.body).toMatchObject({ error: 'rate_limited', help: { label: 'Priority' } });
    // Another person is not affected.
    const s = await signIn(on.app, agent.user.normalizedEmail);
    expect((await s.post('/internal/assistant', ASK)).status).toBe(200);
  });
});
