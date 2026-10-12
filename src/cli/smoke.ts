// Smoke test of a running application over plain HTTP, with both roles.
//
// FOR A TEST ENVIRONMENT. Run it against a throwaway or staging instance when the project needs it (CI does, with
// --write, against a disposable database). It is not part of the production deployment: it signs in with real
// accounts, so against production use the read-only mode, by hand, with accounts you created for it.
//
//   SMOKE_BASE_URL=https://app.example SMOKE_ADMIN_EMAIL=... SMOKE_ADMIN_PASSWORD=... \
//   [SMOKE_AGENT_EMAIL=... SMOKE_AGENT_PASSWORD=...] node dist/cli/smoke.js [--write]
//
// Without --write it only reads: health, redirects, security headers, the prepared AdminJS bundle, CSRF and
// authentication refusals, and what each role can and cannot open. With --write (a throwaway database, for example
// CI) the administrator also creates a group, an agent, a customer and a ticket, and the agent works the ticket.
// Exits with 1 when any check fails. Never prints credentials.
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';

interface Reply {
  status: number;
  headers: Headers;
  text: string;
  location: string | null;
  setCookies: string[];
  json: () => any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** A browser-like client: keeps cookies, follows nothing, sends Origin and the CSRF header on writes. */
class Client {
  private readonly cookies = new Map<string, string>();
  private token = '';

  constructor(private readonly base: string) {}

  private async send(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(new URL(path, this.base), { method, headers: { ...headers, ...(cookie ? { cookie } : {}) }, body, redirect: 'manual' });
    const setCookies = res.headers.getSetCookie();
    for (const line of setCookies) {
      const pair = line.split(';')[0]!;
      const at = pair.indexOf('=');
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1);
      if (value === '' || /expires=thu, 01 jan 1970/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, location: res.headers.get('location'), setCookies, json: () => JSON.parse(text) };
  }

  get(path: string) {
    return this.send('GET', path);
  }

  private origin() {
    return new URL(this.base).origin;
  }

  /** A state-changing JSON request with Origin and the CSRF header (unless `withToken` is false). */
  post(path: string, body: unknown = {}, withToken = true) {
    const headers: Record<string, string> = { 'content-type': 'application/json', origin: this.origin() };
    if (withToken) headers['x-csrf-token'] = this.token;
    return this.send('POST', path, headers, JSON.stringify(body));
  }

  async login(email: string, password: string, withCsrf = true): Promise<Reply> {
    const page = await this.get('/auth/login');
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)?.[1] ?? '';
    const form = new URLSearchParams({ email, password, ...(withCsrf ? { _csrf: csrf } : {}) });
    return this.send('POST', '/auth/login', { 'content-type': 'application/x-www-form-urlencoded', origin: this.origin() }, form.toString());
  }

  async loadToken(): Promise<void> {
    this.token = (await this.get('/auth/csrf')).json().token;
  }
}

class Failure extends Error {}
const must = (condition: unknown, message: string): void => {
  if (!condition) throw new Failure(message);
};
const API = '/admin/api/resources';
/** AdminJS answers a forbidden action with HTTP 200 and a typed base error in the record. */
const refusal = (reply: Reply): string | undefined => {
  try {
    return reply.json().record?.baseError?.type;
  } catch {
    return undefined;
  }
};

const results: Array<{ name: string; error?: string }> = [];
async function check(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    results.push({ name });
    console.log(`  ok    ${name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, error: message });
    console.log(`  FAIL  ${name}: ${message}`);
  }
}

const required = (key: string): string => {
  const value = process.env[key];
  if (!value) {
    console.error(`Set ${key}.`);
    process.exit(2);
  }
  return value;
};

const { values: flags } = parseArgs({ options: { write: { type: 'boolean' } } });
const base = required('SMOKE_BASE_URL');
const adminEmail = required('SMOKE_ADMIN_EMAIL');
const adminPassword = required('SMOKE_ADMIN_PASSWORD');
const write = flags.write === true;
if (write && process.env.SMOKE_AGENT_EMAIL) {
  console.error('--write creates its own agent: do not set SMOKE_AGENT_EMAIL.');
  process.exit(2);
}
const run = Date.now().toString(36);
const generatedAgent = write ? { email: `smoke-agent-${run}@example.test`, password: randomBytes(18).toString('base64url') } : undefined;
const agentEmail = generatedAgent?.email ?? process.env.SMOKE_AGENT_EMAIL;
const agentPassword = generatedAgent?.password ?? process.env.SMOKE_AGENT_PASSWORD;
const agentLogin = agentEmail && agentPassword ? { email: agentEmail, password: agentPassword } : undefined;

console.log(`smoke test of ${base}${write ? ' (with writes)' : ' (read only)'}`);
const anonymous = new Client(base);
const admin = new Client(base);
const agent = new Client(base);

// ---- without a session
await check('liveness: /health/live answers ok', async () => {
  const r = await anonymous.get('/health/live');
  must(r.status === 200 && r.json().status === 'ok', `status ${r.status}`);
});
await check('readiness: /health/ready answers ok (database reachable)', async () => {
  const r = await anonymous.get('/health/ready');
  must(r.status === 200 && r.json().status === 'ok', `status ${r.status}`);
  must(!/postgres|password|DATABASE_URL/i.test(r.text), 'the answer leaks configuration');
});
await check('the bare address and /admin lead to the sign-in page', async () => {
  const root = await anonymous.get('/');
  must(root.status === 302 && root.location === '/admin', `/ gave ${root.status} ${root.location}`);
  const panel = await anonymous.get('/admin');
  must(panel.status === 302 && panel.location === '/auth/login', `/admin gave ${panel.status} ${panel.location}`);
});
await check('the sign-in page has safe headers and no X-Powered-By', async () => {
  const r = await anonymous.get('/auth/login');
  must(r.status === 200, `status ${r.status}`);
  must(r.headers.get('x-content-type-options') === 'nosniff', 'X-Content-Type-Options is not nosniff');
  must(!r.headers.has('x-powered-by'), 'X-Powered-By is present');
});
await check('the admin API refuses an anonymous request with 401', async () => {
  const r = await anonymous.get(`${API}/Ticket/actions/list`);
  must(r.status === 401, `status ${r.status}`);
});
await check('sign-in without the CSRF token is refused', async () => {
  const r = await new Client(base).login(adminEmail, adminPassword, false);
  must(r.status === 403, `status ${r.status}`);
});
await check('a wrong password is refused', async () => {
  const r = await new Client(base).login(adminEmail, `${adminPassword}-wrong`);
  must(r.status === 401, `status ${r.status}`);
});

// ---- ADMIN
await check('ADMIN signs in and gets a protected session cookie', async () => {
  const r = await admin.login(adminEmail, adminPassword);
  must(r.status === 303 && r.location === '/admin', `status ${r.status} ${r.location}`);
  const sid = r.setCookies.find((c) => c.startsWith('sid='));
  if (!sid || !/HttpOnly/i.test(sid)) throw new Failure('the session cookie is missing or not HttpOnly');
  if (new URL(base).protocol === 'https:') must(/Secure/i.test(sid), 'the session cookie is not Secure over HTTPS');
  await admin.loadToken();
});
await check('ADMIN gets the dashboard and every list', async () => {
  const dash = await admin.get('/admin/api/dashboard');
  must(dash.status === 200, `dashboard ${dash.status}`);
  for (const resource of ['Ticket', 'Customer', 'SupportGroup', 'Agent', 'TicketStatus', 'User']) {
    const r = await admin.get(`${API}/${resource}/actions/list`);
    must(r.status === 200 && Array.isArray(r.json().records), `${resource} list gave ${r.status}`);
  }
});
await check('the prepared AdminJS bundle is served', async () => {
  const r = await admin.get('/admin/frontend/assets/components.bundle.js');
  must(r.status === 200 && /javascript/.test(r.headers.get('content-type') ?? '') && r.text.length > 10_000, `status ${r.status}, ${r.text.length} bytes`);
});
await check('a write without the CSRF token is refused', async () => {
  const r = await admin.post(`${API}/Customer/actions/new`, { name: 'No token', emailNormalized: `no-token-${run}@example.test` }, false);
  must(r.status === 403, `status ${r.status}`);
});

// ---- ADMIN prepares data (throwaway databases only)
const made: { groupId?: string; agentRecordId?: string; customerId?: string } = {};
if (write) {
  await check('ADMIN creates a group, an agent in it and a customer', async () => {
    const group = await admin.post(`${API}/SupportGroup/actions/new`, { code: `SMOKE_${run.toUpperCase()}`, name: `Smoke ${run}`, description: 'created by the smoke test' });
    must(group.status === 200 && group.json().record?.id, `group gave ${group.status} ${group.text.slice(0, 240)}`);
    made.groupId = group.json().record.id;
    const user = await admin.post(`${API}/User/actions/new`, { normalizedEmail: agentEmail, displayName: `Smoke Agent ${run}`, role: 'AGENT', password: agentPassword });
    must(user.status === 200 && Object.keys(user.json().record?.errors ?? {}).length === 0, `agent account gave ${user.status} ${user.text.slice(0, 200)}`);
    const found = await admin.get(`${API}/Agent/actions/list?filters.displayName=${encodeURIComponent(`Smoke Agent ${run}`)}`);
    made.agentRecordId = found.json().records?.[0]?.id;
    must(made.agentRecordId, 'the new agent has no Agent profile');
    const member = await admin.post(`${API}/SupportGroup/records/${made.groupId}/addMember`, { agentId: made.agentRecordId });
    must(member.status === 200, `addMember gave ${member.status}`);
    const customer = await admin.post(`${API}/Customer/actions/new`, { name: 'Smoke Customer', emailNormalized: `smoke-customer-${run}@example.test`, company: 'Smoke', phone: '' });
    must(customer.status === 200 && customer.json().record?.id, `customer gave ${customer.status} ${customer.text.slice(0, 240)}`);
    made.customerId = customer.json().record.id;
  });
}

// ---- AGENT
if (agentLogin) {
  await check('AGENT signs in', async () => {
    const r = await agent.login(agentLogin.email, agentLogin.password);
    must(r.status === 303 && r.location === '/admin', `status ${r.status} ${r.location}`);
    await agent.loadToken();
  });
  await check('AGENT sees tickets and customers', async () => {
    for (const resource of ['Ticket', 'Customer']) {
      const r = await agent.get(`${API}/${resource}/actions/list`);
      must(r.status === 200 && Array.isArray(r.json().records), `${resource} list gave ${r.status}`);
    }
  });
  await check('AGENT cannot open or create accounts', async () => {
    must(refusal(await agent.get(`${API}/User/actions/list`)) === 'ForbiddenError', 'the account list is open to an agent');
    const create = await agent.post(`${API}/User/actions/new`, { normalizedEmail: `no-${run}@example.test`, displayName: 'No', role: 'ADMIN', password: randomBytes(12).toString('base64url') });
    must(refusal(create) === 'ForbiddenError', 'an agent can create accounts');
  });
} else {
  console.log('  skip  AGENT checks (set SMOKE_AGENT_EMAIL and SMOKE_AGENT_PASSWORD, or use --write)');
}

// ---- the business flow of both roles (throwaway databases only)
if (write && made.groupId && made.customerId && made.agentRecordId) {
  let ticketId = '';
  let version = 1;
  await check('AGENT creates a ticket, starts work and comments', async () => {
    const created = await agent.post(`${API}/Ticket/actions/new`, {
      subject: `Smoke ticket ${run}`,
      description: 'created by the smoke test',
      customer: made.customerId,
      group: made.groupId,
      assignedAgent: made.agentRecordId,
      priority: 'HIGH',
    });
    must(created.status === 200 && created.json().record?.id, `create gave ${created.status} ${created.text.slice(0, 200)}`);
    ticketId = created.json().record.id;
    version = Number(created.json().record.params?.version ?? 1);
    const started = await agent.post(`${API}/Ticket/records/${ticketId}/changeStatus`, { version, targetStatus: 'IN_PROGRESS' });
    must(started.status === 200, `changeStatus gave ${started.status} ${started.text.slice(0, 200)}`);
    version += 1;
    const comment = await agent.post(`${API}/Ticket/records/${ticketId}/addComment`, { body: 'Smoke comment' });
    must(comment.status === 200, `addComment gave ${comment.status}`);
    const history = await agent.get(`${API}/Ticket/records/${ticketId}/history`);
    must(history.status === 200 && history.json().items?.length >= 2, 'the history lacks the created and status entries');
  });
  await check('the rules hold: a stale version is a conflict, a forbidden transition is refused', async () => {
    const stale = await agent.post(`${API}/Ticket/records/${ticketId}/changeStatus`, { version: version - 1, targetStatus: 'WAITING_CUSTOMER', reason: 'stale' });
    must(stale.status === 409, `stale version gave ${stale.status}`);
    const forbidden = await agent.post(`${API}/Ticket/records/${ticketId}/changeStatus`, { version, targetStatus: 'CLOSED' });
    must(forbidden.status === 422 || forbidden.status === 403, `a forbidden transition gave ${forbidden.status}`);
  });
  await check('ADMIN changes the status in bulk and a bad batch changes nothing', async () => {
    const batch = await admin.post(`${API}/Ticket/bulk/bulkChangeStatus?recordIds=${ticketId}`, {
      items: [{ id: ticketId, version }],
      targetStatus: 'WAITING_CUSTOMER',
      reason: 'asked the customer for details',
    });
    must(batch.status === 200 && batch.json().changed?.length === 1, `bulk gave ${batch.status} ${batch.text.slice(0, 200)}`);
    const again = await admin.post(`${API}/Ticket/bulk/bulkChangeStatus?recordIds=${ticketId}`, { items: [{ id: ticketId, version }], targetStatus: 'IN_PROGRESS', reason: 'stale on purpose' });
    must(again.status === 409 && again.json().error === 'bulk_rejected', `a stale batch gave ${again.status}`);
  });
}

// ---- signing out ends the session
for (const [label, client, wanted] of [['ADMIN', admin, true], ['AGENT', agent, agentLogin !== undefined]] as const) {
  if (!wanted) continue;
  await check(`${label} signs out and the session is over`, async () => {
    const out = await client.post('/auth/logout');
    must(out.status === 302 || out.status === 303 || out.status === 200, `logout gave ${out.status}`);
    const after = await client.get(`${API}/Ticket/actions/list`);
    must(after.status === 401, `the session still works (${after.status})`);
  });
}

const failed = results.filter((r) => r.error);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
