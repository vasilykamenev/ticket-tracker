import Anthropic from '@anthropic-ai/sdk';
import type { Env } from '../config/env.js';

export type UnavailableReason = 'timeout' | 'rate_limited' | 'server' | 'refused' | 'config' | 'empty';

/** The provider could not give an answer; the caller falls back to the field's static help. */
export class AssistantUnavailableError extends Error {
  constructor(readonly reason: UnavailableReason) {
    super(`assistant unavailable: ${reason}`);
    this.name = 'AssistantUnavailableError';
  }
}

/** One question in, plain text out. The model has no tools and cannot read or write anything. */
export interface AssistantProvider {
  ask(system: string, user: string): Promise<string>;
}

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  effort: 'low' | 'medium' | 'high';
  /** Counts the model's reasoning as well as the answer, so it is generous; the answer itself is asked to be short. */
  maxTokens: number;
  /** The whole call: no retries, so this is also the longest a person waits. */
  timeoutMs: number;
  fetch?: typeof globalThis.fetch;
}

/** Logs only the kind of failure: provider messages can echo a request, and nothing here may carry a key or a question. */
function toUnavailable(err: unknown): AssistantUnavailableError {
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new AssistantUnavailableError('timeout');
  if (err instanceof Anthropic.RateLimitError) return new AssistantUnavailableError('rate_limited');
  if (err instanceof Anthropic.APIConnectionError) return new AssistantUnavailableError('server');
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === 'number' ? err.status : 0;
    if (status >= 500) return new AssistantUnavailableError('server');
    // 400, 401, 403, 404: the key, the model name or the request is wrong. Worth an operator's attention.
    console.error('assistant: the provider rejected the request, status', status);
    return new AssistantUnavailableError('config');
  }
  console.error('assistant: unexpected error', err instanceof Error ? err.name : 'unknown');
  return new AssistantUnavailableError('server');
}

export function createAnthropicProvider(options: AnthropicProviderOptions): AssistantProvider {
  const client = new Anthropic({
    apiKey: options.apiKey,
    timeout: options.timeoutMs,
    maxRetries: 0,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  return {
    async ask(system, user) {
      let message: Anthropic.Message;
      try {
        message = await client.messages.create({
          model: options.model,
          max_tokens: options.maxTokens,
          system,
          messages: [{ role: 'user', content: user }],
          output_config: { effort: options.effort },
        });
      } catch (err) {
        throw toUnavailable(err);
      }
      // A safety classifier may decline (HTTP 200); the field's static help is the answer then.
      if (message.stop_reason === 'refusal') throw new AssistantUnavailableError('refused');
      const text = message.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('')
        .trim();
      if (text === '') throw new AssistantUnavailableError('empty');
      return text;
    },
  };
}

/**
 * Answers from the context alone, without calling anything: for development and tests, so the widget can be tried
 * without a key. It is refused in production by the configuration check.
 */
export function createFakeProvider(): AssistantProvider {
  return {
    async ask(_system, user) {
      const raw = /<field_context>\n([\s\S]*?)\n<\/field_context>/.exec(user)?.[1];
      const ctx = raw ? (JSON.parse(raw) as { label?: string; help?: string; validation?: string }) : {};
      const asked = /<question>\n([\s\S]*?)\n<\/question>/.exec(user)?.[1]?.slice(0, 80) ?? '';
      return `[test answer] ${ctx.label ?? 'This field'}: ${ctx.help ?? 'no help text'} ${ctx.validation ?? ''} (You asked: ${asked})`.replace(/\s+/g, ' ').trim();
    },
  };
}

export function createProviderFromEnv(env: Env): AssistantProvider {
  if (env.AI_PROVIDER === 'fake') return createFakeProvider();
  return createAnthropicProvider({
    apiKey: env.ANTHROPIC_API_KEY!, // the configuration check requires it when the assistant is enabled
    model: env.AI_MODEL,
    effort: env.AI_EFFORT,
    maxTokens: env.AI_MAX_OUTPUT_TOKENS,
    timeoutMs: env.AI_TIMEOUT_MS,
  });
}
