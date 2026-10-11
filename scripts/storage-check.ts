// Smoke test of the configured storage: for each file type the application accepts, write a tiny object, read
// its size back, find it by listing, create a download URL and delete it. Run it after configuring S3_* and before relying on
// uploads. Prints no secrets and no URLs. It also shows which types the bucket refuses, so you know what to
// allow in the bucket's settings (Supabase buckets can restrict MIME types and file size).
import { randomUUID } from 'node:crypto';
import { loadStorageEnv } from '../src/config/env.js';
import { createStorage } from '../src/storage/index.js';

const storage = createStorage(loadStorageEnv());

/** The four kinds of file the application accepts (tiny stand-ins; only the declared type matters here). */
const SAMPLES: Array<{ type: string; body: Buffer }> = [
  { type: 'image/png', body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { type: 'image/jpeg', body: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) },
  { type: 'application/pdf', body: Buffer.from('%PDF-1.4\n') },
  { type: 'text/plain', body: Buffer.from('storage check') },
];

const failures: string[] = [];
for (const { type, body } of SAMPLES) {
  const key = `tickets/_check/${randomUUID()}`;
  try {
    await storage.put(key, body, type);
    const head = await storage.head(key);
    if (head?.size !== body.length) throw new Error('head returned an unexpected size');
    // Listing is what `storage:reconcile` relies on to find objects that have no database row.
    let listed = false;
    for await (const object of storage.list(key)) if (object.key === key) listed = true;
    if (!listed) throw new Error('the object was not found when listing');
    const url = await storage.presignGet(key, { filename: 'check', contentType: type, expiresSeconds: 60 });
    if (!url.startsWith('http')) throw new Error('presigned URL is malformed');
    await storage.delete(key);
    if (await storage.head(key)) throw new Error('object still exists after delete');
    console.log(`  ok      ${type}`);
  } catch (err) {
    await storage.delete(key).catch(() => undefined);
    const message = err instanceof Error ? err.message : 'unknown error';
    failures.push(type);
    console.log(`  FAILED  ${type}: ${message}`);
  }
}

if (failures.length === 0) {
  console.log(`storage ok (bucket ${storage.bucket})`);
} else {
  console.error(`\nstorage check FAILED for: ${failures.join(', ')}`);
  if (failures.length < SAMPLES.length) {
    console.error('Writing works, but the bucket refuses some types. In the bucket settings, allow image/png, image/jpeg, application/pdf and text/plain (or remove the restriction) and set the file size limit to at least 10 MiB (the application limit is 10 MiB). The application validates every file itself.');
  } else {
    console.error('Nothing could be written: check S3_ENDPOINT, S3_REGION, the access keys and that the bucket exists.');
  }
  process.exit(1);
}
