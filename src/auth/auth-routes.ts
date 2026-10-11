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

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;background:#f4f5f7;display:grid;place-items:center;min-height:100vh;margin:0}main{background:#fff;padding:2rem;border-radius:8px;width:min(22rem,90vw);box-shadow:0 1px 4px #0002}label{display:block;margin:.75rem 0 .25rem}input{width:100%;box-sizing:border-box;padding:.5rem}button{margin-top:1rem;padding:.5rem 1rem}.err{color:#b00020}</style></head><body><main>${body}</main></body></html>`;
}

function loginPage(token: string, error?: string): string {
  return page(
    'Sign in',
    `<h1>Sign in</h1>${error ? `<p class="err" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/auth/login">
<input type="hidden" name="_csrf" value="${escapeHtml(token)}">
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required maxlength="254">
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="${MAX_PASSWORD_LENGTH}">
<button type="submit">Sign in</button></form>`,
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
        `<h1>Sign out?</h1><form method="post" action="/auth/logout"><input type="hidden" name="_csrf" value="${escapeHtml(ensureCsrfToken(req))}"><button type="submit">Sign out</button></form>`,
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
