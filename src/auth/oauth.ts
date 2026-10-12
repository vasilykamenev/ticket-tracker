import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Env } from '../config/env.js';

/** The fetch used to talk to the providers; tests replace it. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type ProviderId = 'google' | 'github';

export interface OAuthProvider {
  id: ProviderId;
  label: string;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  /** The verified e-mail address of the person who signed in, or null when the provider has none that is verified. */
  verifiedEmail(accessToken: string, doFetch: Fetch): Promise<string | null>;
}

const TIMEOUT_MS = 10_000;

async function getJson(doFetch: Fetch, url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await doFetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.json();
}

const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

function google(env: Env): OAuthProvider | null {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  return {
    id: 'google',
    label: 'Google',
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email',
    async verifiedEmail(accessToken, doFetch) {
      const info = record(await getJson(doFetch, 'https://openidconnect.googleapis.com/v1/userinfo', { Authorization: `Bearer ${accessToken}` }));
      return typeof info.email === 'string' && info.email_verified === true ? info.email : null;
    },
  };
}

function github(env: Env): OAuthProvider | null {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return null;
  return {
    id: 'github',
    label: 'GitHub',
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scope: 'user:email',
    async verifiedEmail(accessToken, doFetch) {
      const emails = await getJson(doFetch, 'https://api.github.com/user/emails', {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'ticket-tracker',
      });
      if (!Array.isArray(emails)) return null;
      // Only the primary address, and only when GitHub has verified it: a secondary or unverified one proves nothing.
      const primary = emails.map(record).find((e) => e.primary === true && e.verified === true);
      return typeof primary?.email === 'string' ? primary.email : null;
    },
  };
}

/** The providers that have both a client id and a secret in the environment. */
export function configuredProviders(env: Env): OAuthProvider[] {
  return [google(env), github(env)].filter((p): p is OAuthProvider => p !== null);
}

export const callbackUrl = (publicUrl: string, id: ProviderId) => `${new URL(publicUrl).origin}/auth/oauth/${id}/callback`;

const b64url = (buf: Buffer) => buf.toString('base64url');

/** What is remembered in the session between the redirect to the provider and the callback. */
export interface PendingOAuth {
  provider: ProviderId;
  state: string;
  verifier: string;
  at: number;
}

export const PENDING_MAX_AGE_MS = 10 * 60 * 1000;

export function newPending(provider: ProviderId): { pending: PendingOAuth; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return {
    pending: { provider, state: b64url(randomBytes(24)), verifier, at: Date.now() },
    challenge: b64url(createHash('sha256').update(verifier).digest()),
  };
}

export function authorizeRedirect(provider: OAuthProvider, publicUrl: string, pending: PendingOAuth, challenge: string): string {
  const url = new URL(provider.authorizeUrl);
  url.search = new URLSearchParams({
    client_id: provider.clientId,
    redirect_uri: callbackUrl(publicUrl, provider.id),
    response_type: 'code',
    scope: provider.scope,
    state: pending.state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

export function stateMatches(expected: string, sent: unknown): boolean {
  if (typeof sent !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(sent);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Exchanges the one-time code for an access token. */
export async function exchangeCode(provider: OAuthProvider, publicUrl: string, code: string, verifier: string, doFetch: Fetch): Promise<string> {
  const res = await doFetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: callbackUrl(publicUrl, provider.id),
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      code_verifier: verifier,
    }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${new URL(provider.tokenUrl).host} answered ${res.status}`);
  const token = record(await res.json()).access_token;
  if (typeof token !== 'string' || token === '') throw new Error('no access token in the answer');
  return token;
}
