import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { csrfProtection } from '../../src/auth/csrf.js';
import { requireUser } from '../../src/auth/require-user.js';
import { loadEnv } from '../../src/config/env.js';
import { limitConcurrentUploads, rejectOversizedBody } from '../../src/http/upload-limits.js';

/**
 * A request refused while a large body is still arriving must have that body discarded at the moment of the
 * refusal, before the response is built; otherwise the client sees a reset connection instead of the reason.
 */
const fakeReq = (extra: object = {}) => {
  const resume = vi.fn();
  const req = { method: 'POST', body: undefined, originalUrl: '/internal/x', session: { destroy: (cb: () => void) => cb() }, get: () => undefined, resume, ...extra };
  return { req: req as unknown as Request, resume };
};
const fakeRes = () => {
  const res = { status: vi.fn(), json: vi.fn(), clearCookie: vi.fn(), redirect: vi.fn(), on: vi.fn() };
  res.status.mockReturnValue(res);
  return res as unknown as Response;
};

describe('refusals discard the unread body', () => {
  it('a CSRF refusal', () => {
    const { req, resume } = fakeReq({ session: { csrfToken: 'expected' } });
    const res = fakeRes();
    const next = vi.fn();
    csrfProtection('http://localhost:3000')(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(resume).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
  });

  it('an unauthenticated request', async () => {
    const { req, resume } = fakeReq({ session: { destroy: (cb: () => void) => cb() } }); // no userId in the session
    const res = fakeRes();
    const env = loadEnv({ PUBLIC_URL: 'http://localhost:3000', DATABASE_URL: 'postgresql://u:p@localhost/db', SESSION_SECRET: 'x'.repeat(32) });
    await requireUser({} as never, env)(req, res, vi.fn() as NextFunction);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(resume).toHaveBeenCalledOnce();
  });

  it('an oversized body and a busy server', () => {
    const big = fakeReq({ get: (name: string) => (name === 'content-length' ? String(11 * 1024 * 1024) : undefined) });
    rejectOversizedBody(big.req, fakeRes(), vi.fn());
    expect(big.resume).toHaveBeenCalledOnce();

    const limit = limitConcurrentUploads(0);
    const busy = fakeReq();
    limit(busy.req, fakeRes(), vi.fn());
    expect(busy.resume).toHaveBeenCalledOnce();
  });

  it('leaves a body that is about to be read alone', () => {
    const ok = fakeReq({ get: (name: string) => (name === 'content-length' ? '1000' : undefined) });
    rejectOversizedBody(ok.req, fakeRes(), vi.fn());
    const limit = limitConcurrentUploads(1);
    const allowed = fakeReq();
    limit(allowed.req, fakeRes(), vi.fn());
    expect(ok.resume).not.toHaveBeenCalled();
    expect(allowed.resume).not.toHaveBeenCalled();
  });
});
