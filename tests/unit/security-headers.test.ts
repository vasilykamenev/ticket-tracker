import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { securityHeaders } from '../../src/http/security-headers.js';

function run(hsts: boolean) {
  const headers = new Map<string, string>();
  let called = false;
  const res = { setHeader: (name: string, value: string) => headers.set(name, value) } as unknown as Response;
  securityHeaders({ hsts })({} as Request, res, () => (called = true));
  return { headers, called };
}

describe('security headers', () => {
  it('forbids sniffing and framing and limits the referrer, then lets the request go on', () => {
    const { headers, called } = run(false);
    expect(called).toBe(true);
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('X-Frame-Options')).toBe('DENY');
    expect(headers.get('Referrer-Policy')).toBe('same-origin');
  });

  it('sends HSTS only when asked to (production)', () => {
    expect(run(false).headers.has('Strict-Transport-Security')).toBe(false);
    expect(run(true).headers.get('Strict-Transport-Security')).toMatch(/^max-age=\d+; includeSubDomains$/);
  });
});
