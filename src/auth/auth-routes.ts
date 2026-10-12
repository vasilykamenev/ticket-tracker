import express, { Router } from 'express';
import type { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { Env } from '../config/env.js';
import { normalizeEmail } from '../domain/users/email.js';
import { ensureCsrfToken } from './csrf.js';
import { MAX_PASSWORD_LENGTH, getDummyHash, verifyPassword } from './password.js';
import { canSignIn, toSessionUser } from './require-user.js';

const GENERIC_ERROR = 'Invalid email or password.';
const THROTTLED_ERROR = 'Too many attempts. Try again later.';

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
.err{margin:0 0 4px;padding:14px 16px;background:#fde8e8;border-left:4px solid #b91c1c;border-radius:4px;color:#7f1d1d}
@media(max-width:700px){.card{flex-direction:column}.welcome{flex:none;padding:28px}.welcome .art{display:none}}`;

// The number after ? is only a cache buster: raise it when public/login-art.png changes (the file is cached for a day).
const ILLUSTRATION = '<img class="art" src="/auth/login-art.png?v=2" alt="" width="220" height="241">';

function page(title: string, body: string, side?: string): string {
  const main = side
    ? `<section class="welcome">${side}</section><section class="form">${body}</section>`
    : `<section class="form">${body}</section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main class="card"${side ? '' : ' style="width:min(26rem,100%);min-height:0"'}>${main}</main></body></html>`;
}

const BRAND = '<div class="brand">Ticket Tracker</div>';

function loginPage(token: string, error?: string): string {
  return page(
    'Sign in',
    `${BRAND}${error ? `<p class="err" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/auth/login">
<input type="hidden" name="_csrf" value="${escapeHtml(token)}">
<label class="req" for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required maxlength="254">
<label class="req" for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="${MAX_PASSWORD_LENGTH}">
<button type="submit">Login</button></form>`,
    `<h2>Welcome</h2><p>to the support ticket tracker: handle customer requests, track their status and keep the whole team in one place.</p>${ILLUSTRATION}`,
  );
}

function noStore(res: Response): void {
  res.set('Cache-Control', 'no-store');
}

export function createAuthRouter(prisma: PrismaClient, env: Env): Router {
  const router = Router();
  const windowMs = env.LOGIN_WINDOW_MINUTES * 60 * 1000;

  const renderThrottled = (req: Request, res: Response) => {
    noStore(res);
    res.status(429).send(loginPage(ensureCsrfToken(req), THROTTLED_ERROR));
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
    if (req.session.userId) return res.redirect(302, '/admin');
    noStore(res);
    res.send(loginPage(ensureCsrfToken(req)));
  });

  // The urlencoded parser runs before CSRF (mounted in app.ts) so `_csrf` is readable; body is bounded.
  router.post('/login', perIp, perAccount, async (req, res, next) => {
    try {
      const fail = () => {
        noStore(res);
        res.status(401).send(loginPage(ensureCsrfToken(req), GENERIC_ERROR));
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

      // Fresh session id at login (prevents session fixation).
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.userId = user.id;
        req.session.sessionVersion = user.sessionVersion;
        req.session.authAt = Date.now();
        req.session.adminUser = toSessionUser(user);
        ensureCsrfToken(req);
        req.session.save((saveErr) => (saveErr ? next(saveErr) : res.redirect(303, '/admin')));
      });
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
