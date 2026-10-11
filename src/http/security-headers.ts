import type { RequestHandler } from 'express';

/**
 * Baseline response headers for every route. Deliberately no Content-Security-Policy: AdminJS renders with inline
 * scripts and styles, so a policy strict enough to matter would break it, and a loose one would only look safe.
 * HSTS is sent only in production, where the application is served over HTTPS (it is ignored over plain HTTP anyway,
 * but a development server should not tell browsers to pin localhost).
 */
export function securityHeaders(options: { hsts: boolean }): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY'); // the admin is never meant to be embedded
    res.setHeader('Referrer-Policy', 'same-origin');
    if (options.hsts) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    next();
  };
}
