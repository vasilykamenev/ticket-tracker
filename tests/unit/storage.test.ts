import { Readable } from 'node:stream';
import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { BusyError, PayloadTooLargeError } from '../../src/domain/errors.js';
import { limitConcurrentUploads, rejectOversizedBody } from '../../src/http/upload-limits.js';
import { MemoryStorage } from '../../src/storage/memory-storage.js';
import { S3Storage } from '../../src/storage/s3-storage.js';
import { contentDisposition } from '../../src/storage/storage.js';
import { loadEnv, loadStorageEnv } from '../../src/config/env.js';

describe('contentDisposition', () => {
  it('is always an attachment, with an ASCII fallback and the UTF-8 form', () => {
    expect(contentDisposition('report.pdf')).toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
    const cyrillic = contentDisposition('Отчёт за октябрь.pdf');
    expect(cyrillic).toContain('attachment; filename="');
    expect(cyrillic).toContain(`filename*=UTF-8''%D0%9E%D1%82%D1%87%D1%91%D1%82`);
    expect(cyrillic).not.toMatch(/[^\x20-\x7e]/);
  });

  it('cannot be broken out of with quotes, line breaks or semicolons', () => {
    const header = contentDisposition('evil";\r\nSet-Cookie: x=1\u0000.txt');
    expect(header).not.toMatch(/[\r\n\u0000]/);
    expect(header.match(/"/g)).toHaveLength(2); // only the two that delimit the fallback name
    expect(header).not.toContain(';\r');
  });
});

describe('MemoryStorage', () => {
  it('stores, reports, lists and deletes (deleting twice is fine)', async () => {
    const storage = new MemoryStorage();
    await storage.put('tickets/a/1', Buffer.from('hello'), 'text/plain');
    await storage.put('other/b', Buffer.from('x'), 'text/plain');
    expect(await storage.head('tickets/a/1')).toEqual({ size: 5 });
    expect(await storage.head('missing')).toBeNull();
    const listed: string[] = [];
    for await (const o of storage.list('tickets/')) listed.push(o.key);
    expect(listed).toEqual(['tickets/a/1']);
    await storage.delete('tickets/a/1');
    await storage.delete('tickets/a/1');
    expect(storage.has('tickets/a/1')).toBe(false);
  });

  it('copies what it stores and can inject a one-off failure', async () => {
    const storage = new MemoryStorage();
    const body = Buffer.from('abc');
    await storage.put('k', body, 'text/plain');
    body[0] = 0;
    expect(storage.get('k')!.toString()).toBe('abc');
    storage.failNext.put = new Error('boom');
    await expect(storage.put('k2', body, 'text/plain')).rejects.toThrow('boom');
    await expect(storage.put('k2', body, 'text/plain')).resolves.toBeUndefined();
  });
});

/** An S3 client whose transport is replaced, so the requests it would send can be inspected without a network. */
function fakeS3(respond: (req: { method: string; path: string; hostname: string }) => { statusCode: number; headers?: Record<string, string> }) {
  const seen: Array<{ method: string; path: string; hostname: string; headers: Record<string, string> }> = [];
  const storage = new S3Storage({
    endpoint: 'https://project.supabase.co/storage/v1/s3',
    region: 'eu-central-1',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'super-secret-key-never-in-urls',
    bucket: 'ticket-attachments',
    clientConfig: {
      requestHandler: {
        handle: async (request: { method: string; path: string; hostname: string; headers: Record<string, string> }) => {
          seen.push({ method: request.method, path: request.path, hostname: request.hostname, headers: request.headers });
          const { statusCode, headers } = respond(request);
          return { response: { statusCode, headers: headers ?? {}, body: Readable.from([]) } };
        },
        destroy() {},
        updateHttpClientConfig() {},
        httpHandlerConfigs: () => ({}),
      } as never,
    },
  });
  return { storage, seen };
}

describe('S3Storage', () => {
  it('uses path-style addressing for put, head and delete', async () => {
    const { storage, seen } = fakeS3(() => ({ statusCode: 200, headers: { 'content-length': '5' } }));
    await storage.put('tickets/t1/comments/c1/abc', Buffer.from('hello'), 'text/plain');
    expect(await storage.head('tickets/t1/comments/c1/abc')).toEqual({ size: 5 });
    await storage.delete('tickets/t1/comments/c1/abc');

    expect(seen.map((r) => r.method)).toEqual(['PUT', 'HEAD', 'DELETE']);
    for (const r of seen) {
      expect(r.hostname).toBe('project.supabase.co');
      expect(r.path).toBe('/storage/v1/s3/ticket-attachments/tickets/t1/comments/c1/abc'); // bucket in the path, not the host
    }
    expect(seen[0]!.headers['content-type']).toBe('text/plain');
    expect(Object.values(seen[0]!.headers).join(' ')).not.toContain('super-secret-key-never-in-urls');
  });

  it('treats a missing object as null on head, and surfaces other errors', async () => {
    expect(await fakeS3(() => ({ statusCode: 404 })).storage.head('gone')).toBeNull();
    await expect(fakeS3(() => ({ statusCode: 500 })).storage.head('boom')).rejects.toBeTruthy();
  });

  it('presigns a 60-second attachment download without leaking the secret key', async () => {
    const { storage, seen } = fakeS3(() => ({ statusCode: 200 }));
    const url = new URL(await storage.presignGet('tickets/t1/comments/c1/abc', { filename: 'Отчёт.pdf', contentType: 'application/pdf', expiresSeconds: 60 }));
    expect(url.hostname).toBe('project.supabase.co');
    expect(url.pathname).toBe('/storage/v1/s3/ticket-attachments/tickets/t1/comments/c1/abc');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('60');
    expect(url.searchParams.get('response-content-disposition')).toMatch(/^attachment; filename="/);
    expect(url.searchParams.get('response-content-type')).toBe('application/pdf');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(url.toString()).not.toContain('super-secret-key-never-in-urls');
    expect(seen).toHaveLength(0); // signing is local: no request is sent
  });
});

describe('upload limits', () => {
  const req = (contentLength?: string) => ({ get: (name: string) => (name.toLowerCase() === 'content-length' ? contentLength : undefined), resume: () => undefined }) as unknown as Request;
  const run = (mw: (a: Request, b: Response, c: (e?: unknown) => void) => void, request: Request, response: Response = {} as Response) => {
    let result: unknown = 'not called';
    mw(request, response, (e) => (result = e));
    return result;
  };

  it('refuses an oversized body from its Content-Length before reading it', () => {
    expect(run(rejectOversizedBody, req(String(11 * 1024 * 1024)))).toBeInstanceOf(PayloadTooLargeError);
    expect(run(rejectOversizedBody, req(String(10 * 1024 * 1024 + 1000)))).toBeUndefined(); // multipart framing allowance
    expect(run(rejectOversizedBody, req(undefined))).toBeUndefined(); // no length: the parser's own limit applies
  });

  it('lets only N uploads run at once and frees the slot when the response ends', () => {
    const limit = limitConcurrentUploads(2);
    const makeRes = () => {
      const handlers: Record<string, () => void> = {};
      return { on: (event: string, fn: () => void) => (handlers[event] = fn), end: () => handlers.finish?.(), close: () => handlers.close?.() } as unknown as Response & { end: () => void; close: () => void };
    };
    const [a, b, c] = [makeRes(), makeRes(), makeRes()];
    expect(run(limit, req(), a)).toBeUndefined();
    expect(run(limit, req(), b)).toBeUndefined();
    expect(run(limit, req(), c)).toBeInstanceOf(BusyError);
    a.end();
    a.close(); // finish and close both fire for a normal response: released once
    expect(run(limit, req(), makeRes())).toBeUndefined();
    expect(run(limit, req(), makeRes())).toBeInstanceOf(BusyError); // b still holds a slot
  });
});

describe('storage configuration', () => {
  const base = { PUBLIC_URL: 'http://localhost:3000', DATABASE_URL: 'postgresql://u:p@localhost/db', SESSION_SECRET: 'x'.repeat(32) };
  const s3 = { S3_ENDPOINT: 'https://p.supabase.co/storage/v1/s3', S3_REGION: 'eu-central-1', S3_ACCESS_KEY_ID: 'id', S3_SECRET_ACCESS_KEY: 'secret' };

  it('is optional in development and treats empty values as unset', () => {
    const env = loadEnv({ ...base, S3_ENDPOINT: '', S3_REGION: '', S3_ACCESS_KEY_ID: '', S3_SECRET_ACCESS_KEY: '', S3_BUCKET: '' });
    expect(env.S3_ENDPOINT).toBeUndefined();
    expect(env.S3_BUCKET).toBe('ticket-attachments');
    expect(env.MAX_CONCURRENT_UPLOADS).toBe(4);
  });

  it('refuses a partial configuration, naming only the missing variables', () => {
    expect(() => loadEnv({ ...base, S3_ENDPOINT: s3.S3_ENDPOINT })).toThrow(/S3_REGION[\s\S]*S3_ACCESS_KEY_ID/);
    expect(() => loadEnv({ ...base, ...s3, S3_SECRET_ACCESS_KEY: '' })).toThrow(/S3_SECRET_ACCESS_KEY/);
    expect(() => loadEnv({ ...base, ...s3, S3_SECRET_ACCESS_KEY: '' })).not.toThrow(/S3_REGION/);
  });

  it('requires storage in production and demo, so uploads never silently go to memory', () => {
    for (const APP_ENV of ['production', 'demo']) {
      const extra = APP_ENV === 'production' ? { PUBLIC_URL: 'https://tickets.example.test' } : {};
      expect(() => loadEnv({ ...base, ...extra, APP_ENV })).toThrow(/S3_ENDPOINT/);
      expect(loadEnv({ ...base, ...extra, ...s3, APP_ENV }).S3_ENDPOINT).toBe(s3.S3_ENDPOINT);
    }
  });

  it('has a narrow loader for the storage scripts that needs no session secret or public URL', () => {
    expect(loadStorageEnv({}).S3_BUCKET).toBe('ticket-attachments');
    expect(loadStorageEnv({ ...s3 }).S3_ENDPOINT).toBe(s3.S3_ENDPOINT);
    expect(() => loadStorageEnv({ S3_ENDPOINT: s3.S3_ENDPOINT })).toThrow(/S3_REGION/);
    expect(() => loadStorageEnv({ APP_ENV: 'production' })).toThrow(/S3_ENDPOINT/);
  });
});
