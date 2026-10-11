import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { discardBody } from '../http/upload-limits.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function ensureCsrfToken(req: Request): string {
  req.session.csrfToken ??= randomBytes(32).toString('base64url');
  return req.session.csrfToken;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Synchronizer-token CSRF protection plus an Origin check.
 * Must be mounted AFTER the session and BEFORE any body parser that touches
 * uploads (the token is read from a header, or from `_csrf` if a form body was already parsed).
 */
export function csrfProtection(publicUrl: string): RequestHandler {
  const allowedOrigin = new URL(publicUrl).origin;
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const body: unknown = req.body;
    const fromBody =
      body && typeof body === 'object' && typeof (body as Record<string, unknown>)._csrf === 'string'
        ? ((body as Record<string, unknown>)._csrf as string)
        : undefined;
    const sent = req.get('x-csrf-token') ?? fromBody;
    const expected = req.session.csrfToken;
    if (req.get('origin') !== allowedOrigin || !sent || !expected || !safeEqual(sent, expected)) {
      discardBody(req);
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
  };
}
