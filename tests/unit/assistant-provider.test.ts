import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantUnavailableError, createAnthropicProvider, createFakeProvider } from '../../src/assistant/provider.js';
import { loadEnv } from '../../src/config/env.js';

const baseOptions = { apiKey: 'sk-test-not-a-real-key', model: 'claude-opus-5-5', effort: 'low' as const, maxTokens: 1024, timeoutMs: 10_000 };

const messageBody = (over: Record<string, unknown> = {}) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [{ type: 'text', text: 'A short answer.' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
  ...over,
});

/** A fetch that answers with a fixed response and records the request it was given. */
function respond(status: number, body: unknown) {
  const seen: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

afterEach(() => vi.restoreAllMocks());

describe('anthropic provider', () => {
  it('sends one bounded request: the configured model, the fixed system text, the user message, low effort and no tools', async () => {
    const { fetch, seen } = respond(200, messageBody());
    const answer = await createAnthropicProvider({ ...baseOptions, fetch }).ask('SYSTEM TEXT', 'USER TEXT');
    expect(answer).toBe('A short answer.');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toMatch(/\/v1\/messages$/);
    expect(seen[0]!.headers.get('x-api-key')).toBe(baseOptions.apiKey);
    expect(seen[0]!.body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 1024,
      system: 'SYSTEM TEXT',
      messages: [{ role: 'user', content: 'USER TEXT' }],
      output_config: { effort: 'low' },
    });
    // Nothing that lets the model do anything but write text.
    expect(seen[0]!.body).not.toHaveProperty('tools');
    expect(seen[0]!.body).not.toHaveProperty('tool_choice');
    expect(seen[0]!.body).not.toHaveProperty('stream');
  });

  it('joins the text blocks of the reply and ignores the rest', async () => {
    const { fetch } = respond(200, messageBody({ content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: 'One ' }, { type: 'text', text: 'two.' }] }));
    expect(await createAnthropicProvider({ ...baseOptions, fetch }).ask('s', 'u')).toBe('One two.');
  });

  it.each([
    [429, 'rate_limited'],
    [500, 'server'],
    [529, 'server'],
  ])('answers an HTTP %i as "unavailable: %s", without retrying', async (status, reason) => {
    const { fetch, seen } = respond(status, { type: 'error', error: { type: 'api_error', message: 'nope' } });
    await expect(createAnthropicProvider({ ...baseOptions, fetch }).ask('s', 'u')).rejects.toMatchObject({ reason });
    expect(seen).toHaveLength(1); // no retry: the wait stays within the timeout
  });

  it('treats a rejected key or model (401, 404) as a configuration problem, and logs only the status', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const status of [401, 404]) {
      const { fetch } = respond(status, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key sk-test-not-a-real-key' } });
      await expect(createAnthropicProvider({ ...baseOptions, fetch }).ask('s', 'u')).rejects.toMatchObject({ reason: 'config' });
    }
    const logged = log.mock.calls.flat().join(' ');
    expect(logged).toMatch(/status 401/);
    expect(logged).not.toMatch(/sk-test|invalid x-api-key/);
  });

  it('gives up after the timeout', async () => {
    const hang = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      })) as typeof globalThis.fetch;
    const started = Date.now();
    await expect(createAnthropicProvider({ ...baseOptions, timeoutMs: 40, fetch: hang }).ask('s', 'u')).rejects.toMatchObject({ reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('answers a refusal or an empty reply as unavailable', async () => {
    const refusal = respond(200, messageBody({ content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null } }));
    await expect(createAnthropicProvider({ ...baseOptions, fetch: refusal.fetch }).ask('s', 'u')).rejects.toMatchObject({ reason: 'refused' });
    const empty = respond(200, messageBody({ content: [{ type: 'text', text: '   ' }] }));
    await expect(createAnthropicProvider({ ...baseOptions, fetch: empty.fetch }).ask('s', 'u')).rejects.toBeInstanceOf(AssistantUnavailableError);
  });

  it('answers a network failure as unavailable', async () => {
    const down = (async () => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof globalThis.fetch;
    await expect(createAnthropicProvider({ ...baseOptions, fetch: down }).ask('s', 'u')).rejects.toMatchObject({ reason: 'server' });
  });
});

describe('fake provider', () => {
  it('answers from the context in the message, without calling anything', async () => {
    const text = await createFakeProvider().ask('s', 'Field context (JSON):\n<field_context>\n{"label":"Priority","help":"LOW or HIGH."}\n</field_context>\n\n<question>\nWhat?\n</question>');
    expect(text).toMatch(/Priority: LOW or HIGH\./);
    expect(text).toMatch(/You asked: What\?/);
  });
});

describe('assistant configuration', () => {
  const base = { APP_ENV: 'development', PUBLIC_URL: 'http://localhost:3000', DATABASE_URL: 'postgresql://x', SESSION_SECRET: 'x'.repeat(40) };

  it('is off by default, with the limits of the requirements', () => {
    const env = loadEnv(base);
    expect(env).toMatchObject({ AI_ENABLED: false, AI_PROVIDER: 'anthropic', AI_RATE_PER_MINUTE: 10, AI_TIMEOUT_MS: 10_000, AI_MODEL: 'claude-opus-5-5', AI_EFFORT: 'low' });
    expect(loadEnv({ ...base, AI_ENABLED: '' }).AI_ENABLED).toBe(false);
  });

  it('needs a key when enabled, and refuses the fake provider in production', () => {
    expect(() => loadEnv({ ...base, AI_ENABLED: 'true' })).toThrow(/ANTHROPIC_API_KEY: required when AI_ENABLED=true/);
    expect(loadEnv({ ...base, AI_ENABLED: 'true', ANTHROPIC_API_KEY: 'sk-x' }).AI_ENABLED).toBe(true);
    expect(loadEnv({ ...base, AI_ENABLED: 'true', AI_PROVIDER: 'fake' }).AI_ENABLED).toBe(true);
    const prod = { ...base, APP_ENV: 'production', PUBLIC_URL: 'https://x.example', S3_ENDPOINT: 'https://s3.example', S3_REGION: 'r', S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 'b' };
    expect(() => loadEnv({ ...prod, AI_ENABLED: 'true', AI_PROVIDER: 'fake' })).toThrow(/fake provider is not allowed in production/);
  });

  it('rejects values that are not what they claim to be', () => {
    expect(() => loadEnv({ ...base, AI_ENABLED: 'yes' })).toThrow(/AI_ENABLED/);
    expect(() => loadEnv({ ...base, AI_RATE_PER_MINUTE: '0' })).toThrow(/AI_RATE_PER_MINUTE/);
  });
});
