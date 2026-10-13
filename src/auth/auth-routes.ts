import { AUTHOR_EMAIL, AUTHOR_NAME, copyrightYears } from '../author.js';
import express, { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { Agent, PrismaClient, User } from '@prisma/client';
import { z } from 'zod';
import type { Env } from '../config/env.js';
import { normalizeEmail } from '../domain/users/email.js';
import { ensureCsrfToken } from './csrf.js';
import { MAX_PASSWORD_LENGTH, getDummyHash, verifyPassword } from './password.js';
import { type Fetch, type OAuthProvider, PENDING_MAX_AGE_MS, authorizeRedirect, configuredProviders, exchangeCode, newPending, stateMatches } from './oauth.js';
import { canSignIn, toSessionUser } from './require-user.js';

const GENERIC_ERROR = 'Invalid email or password.';
const THROTTLED_ERROR = 'Too many attempts. Try again later.';
const oauthError = (label: string) => `Signing in with ${label} was not possible for this account. Ask an administrator to check that your account exists and is active.`;

const loginBody = z.object({
  email: z.string().max(254),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// Styled after the AdminJS sign-in screen: grey page, white card, blue welcome panel on the left.
const STYLE = `*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#f8f9f9;color:#212529;font-family:Roboto,"Helvetica Neue",Arial,sans-serif;font-size:14px}
.card{display:flex;width:min(860px,100%);min-height:520px;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 15px 40px rgba(0,0,0,.08)}
.welcome{flex:0 0 40%;background:#3040d6;color:#fff;padding:40px 38px;display:flex;flex-direction:column}
.welcome h2{margin:24px 0 24px;font-size:30px;font-weight:300;line-height:1.2}
.welcome p{margin:0;font-size:14px;line-height:1.8;font-weight:300}
.welcome .art{display:block;width:220px;height:auto;margin:32px auto 0}
.form{flex:1;padding:38px;display:flex;flex-direction:column;justify-content:flex-start}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:30px;font-size:22px;font-weight:700;color:#1a1c28}
h1{margin:0 0 20px;font-size:20px;font-weight:600}
label{display:block;margin:16px 0 6px;font-size:12px}
label.req:before{content:"* ";color:#3040d6}
input{width:100%;height:42px;padding:0 12px;font:inherit;font-size:14px;border:1px solid #c0c0ca;border-radius:4px;background:#fff;color:#212529}
input:focus{outline:none;border-color:#3040d6;box-shadow:0 0 0 3px rgba(48,64,214,.15)}
button{display:block;margin:28px auto 0;min-width:80px;height:34px;padding:0 24px;font:inherit;font-size:14px;color:#fff;background:#3040d6;border:0;border-radius:4px;cursor:pointer}
button:hover{background:#2431b0}
.or{display:flex;align-items:center;gap:12px;margin:26px 0 4px;color:#6b7280;font-size:12px}.or:before,.or:after{content:"";flex:1;height:1px;background:#dfe1e6}
.oauth{display:flex;align-items:center;justify-content:center;gap:10px;margin-top:12px;height:42px;border:1px solid #c0c0ca;border-radius:4px;color:#212529;text-decoration:none;background:#fff}.oauth:hover{background:#f4f5f7}.oauth svg{width:18px;height:18px}
.err{margin:0 0 4px;padding:14px 16px;background:#fde8e8;border-left:4px solid #b91c1c;border-radius:4px;color:#7f1d1d}
footer{position:fixed;left:0;right:0;bottom:10px;text-align:center;font-size:12px;color:#6b7280}footer a{color:inherit}
@media(max-width:700px){.card{flex-direction:column}.welcome{flex:none;padding:28px}.welcome .art{display:none}}`;

// The number after ? is only a cache buster: raise it when public/login-art.png changes (the file is cached for a day).
const ILLUSTRATION = '<img class="art" src="/auth/login-art.png?v=2" alt="" width="220" height="241">';

function page(title: string, body: string, side?: string): string {
  const main = side
    ? `<section class="welcome">${side}</section><section class="form">${body}</section>`
    : `<section class="form">${body}</section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main class="card"${side ? '' : ' style="width:min(26rem,100%);min-height:0"'}>${main}</main><footer>© ${copyrightYears()} <a href="mailto:${AUTHOR_EMAIL}" title="Write to ${AUTHOR_EMAIL}">${AUTHOR_NAME}</a></footer></body></html>`;
}

const BRAND = '<div class="brand">Ticket Tracker</div>';

const ICONS: Record<OAuthProvider['id'], string> = {
  google:
    '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.2 5.4-4.7 7.1l7.6 5.9c4.4-4.1 6.9-10.1 6.9-17.5z"/><path fill="#FBBC05" d="M10.5 28.7a14.5 14.5 0 0 1 0-9.4l-7.9-6.1a24 24 0 0 0 0 21.6l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>',
  github:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="#24292f" d="M8 0C3.6 0 0 3.6 0 8c0 3.5 2.3 6.5 5.5 7.6.4.1.5-.2.5-.4v-1.4c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.2 1.9.9 2.3.7.1-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-4 0-.9.3-1.6.8-2.1-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8a7.5 7.5 0 0 1 4 0c1.5-1 2.2-.8 2.2-.8.4 1.1.2 1.9.1 2.1.5.6.8 1.3.8 2.1 0 3.1-1.9 3.7-3.6 3.9.3.3.5.8.5 1.5v2.2c0 .2.1.5.6.4A8 8 0 0 0 16 8c0-4.4-3.6-8-8-8z"/></svg>',
};

function loginPage(token: string, providers: OAuthProvider[], error?: string): string {
  const oauth = providers.length
    ? `<div class="or">or</div>${providers.map((p) => `<a class="oauth" href="/auth/oauth/${p.id}">${ICONS[p.id]}Continue with ${escapeHtml(p.label)}</a>`).join('')}`
    : '';
  return page(
    'Sign in',
    `${BRAND}${error ? `<p class="err" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/auth/login">
<input type="hidden" name="_csrf" value="${escapeHtml(token)}">
<label class="req" for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required maxlength="254">
<label class="req" for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="${MAX_PASSWORD_LENGTH}">
<button type="submit">Login</button></form>${oauth}`,
    `<h2>Welcome</h2><p>to the support ticket tracker: handle customer requests, track their status and keep the whole team in one place.</p>${ILLUSTRATION}`,
  );
}

function noStore(res: Response): void {
  res.set('Cache-Control', 'no-store');
}

export interface AuthOptions {
  /** The fetch used to talk to the OAuth providers (tests replace it). */
  fetch?: Fetch;
}

export function createAuthRouter(prisma: PrismaClient, env: Env, options: AuthOptions = {}): Router {
  const router = Router();
  const providers = configuredProviders(env);
  const doFetch: Fetch = options.fetch ?? ((url, init) => fetch(url, init));
  const windowMs = env.LOGIN_WINDOW_MINUTES * 60 * 1000;

  const renderThrottled = (req: Request, res: Response) => {
    noStore(res);
    res.status(429).send(loginPage(ensureCsrfToken(req), providers, THROTTLED_ERROR));
  };

  // In-memory counters: valid for a single replica only (documented limitation).
  const perIp = rateLimit({
    windowMs,
    limit: env.LOGIN_MAX_PER_IP,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: renderThrottled,
  });
  const perAccount = rateLimit({
    windowMs,
    limit: env.LOGIN_MAX_FAILED_PER_ACCOUNT,
    skipSuccessfulRequests: true,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const email: unknown = req.body?.email;
      return typeof email === 'string' ? normalizeEmail(email).slice(0, 254) : 'invalid';
    },
    handler: renderThrottled,
    validate: { keyGeneratorIpFallback: false },
  });

  /** Fresh session id at login (prevents session fixation), then into the admin. Shared by both ways of signing in. */
  const startSession = (req: Request, res: Response, next: NextFunction, user: User & { agent: Agent | null }) => {
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.userId = user.id;
      req.session.sessionVersion = user.sessionVersion;
      req.session.authAt = Date.now();
      req.session.adminUser = toSessionUser(user);
      ensureCsrfToken(req);
      req.session.save((saveErr) => (saveErr ? next(saveErr) : res.redirect(303, '/app')));
    });
  };

  // Token for the AdminJS client (see public/csrf-client.js). Same-origin only, never cached.
  router.get('/csrf', (req, res) => {
    const site = req.get('sec-fetch-site');
    if (site !== undefined && site !== 'same-origin' && site !== 'none') {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    noStore(res);
    res.json({ token: ensureCsrfToken(req) });
  });

  router.get('/login', (req, res) => {
    if (req.session.userId) return res.redirect(302, '/app');
    noStore(res);
    res.send(loginPage(ensureCsrfToken(req), providers));
  });

  // The urlencoded parser runs before CSRF (mounted in app.ts) so `_csrf` is readable; body is bounded.
  router.post('/login', perIp, perAccount, async (req, res, next) => {
    try {
      const fail = () => {
        noStore(res);
        res.status(401).send(loginPage(ensureCsrfToken(req), providers, GENERIC_ERROR));
      };
      const parsed = loginBody.safeParse(req.body);
      if (!parsed.success) return fail();

      const user = await prisma.user.findUnique({
        where: { normalizedEmail: normalizeEmail(parsed.data.email) },
        include: { agent: true },
      });
      // Always verify a hash so unknown email and wrong password cost the same.
      const passwordOk = await verifyPassword(user?.passwordHash ?? (await getDummyHash()), parsed.data.password);
      if (!user || !passwordOk || !canSignIn(user)) return fail();

      startSession(req, res, next, user);
    } catch (err) {
      next(err);
    }
  });

  // ---- sign-in with Google or GitHub (authorization code flow with PKCE and a state value)
  // An identity only opens an account that already exists: matched by the provider's verified e-mail address, and
  // the account must be allowed to sign in. Nothing is created here, so no outsider can become a user, let alone an admin.
  const providerOf = (id: string) => providers.find((p) => p.id === id);

  router.get('/oauth/:provider', perIp, (req, res, next) => {
    const provider = providerOf(String(req.params.provider));
    if (!provider) return res.status(404).type('text').send('Not found');
    if (req.session.userId) return res.redirect(302, '/app');
    const { pending, challenge } = newPending(provider.id);
    req.session.oauth = pending;
    noStore(res);
    req.session.save((err) => (err ? next(err) : res.redirect(302, authorizeRedirect(provider, env.PUBLIC_URL, pending, challenge))));
  });

  router.get('/oauth/:provider/callback', perIp, async (req, res, next) => {
    try {
      const provider = providerOf(String(req.params.provider));
      if (!provider) return res.status(404).type('text').send('Not found');
      const fail = () => {
        noStore(res);
        res.status(401).send(loginPage(ensureCsrfToken(req), providers, oauthError(provider.label)));
      };
      // The pending record is single-use: read it and drop it before anything else.
      const pending = req.session.oauth;
      delete req.session.oauth;
      const code = req.query.code;
      if (!pending || pending.provider !== provider.id || Date.now() - pending.at > PENDING_MAX_AGE_MS) return fail();
      if (!stateMatches(pending.state, req.query.state) || typeof code !== 'string' || code === '' || code.length > 2048) return fail();

      let email: string | null;
      try {
        const token = await exchangeCode(provider, env.PUBLIC_URL, code, pending.verifier, doFetch);
        email = await provider.verifiedEmail(token, doFetch);
      } catch {
        return fail(); // the provider refused or is unreachable: nothing is revealed, nobody is signed in
      }
      if (!email) return fail();

      const user = await prisma.user.findUnique({ where: { normalizedEmail: normalizeEmail(email) }, include: { agent: true } });
      if (!user || !canSignIn(user)) return fail();
      startSession(req, res, next, user);
    } catch (err) {
      next(err);
    }
  });

  // AdminJS renders logout as a plain link (GET). GET only shows a confirmation; the POST mutates.
  router.get('/logout', (req, res) => {
    if (!req.session.userId) return res.redirect(302, '/auth/login');
    noStore(res);
    res.send(
      page(
        'Sign out',
        `${BRAND}<h1>Sign out?</h1><form method="post" action="/auth/logout"><input type="hidden" name="_csrf" value="${escapeHtml(ensureCsrfToken(req))}"><button type="submit">Sign out</button></form>`,
      ),
    );
  });

  router.post('/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('sid');
      res.redirect(303, '/auth/login');
    });
  });

  return router;
}

/** Bounded parser for the plain HTML login/logout forms only. */
export const authFormParser = express.urlencoded({ extended: false, limit: '4kb' });
