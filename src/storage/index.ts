import type { StorageEnv } from '../config/env.js';
import { MemoryStorage } from './memory-storage.js';
import { S3Storage } from './s3-storage.js';
import type { ObjectStorage } from './storage.js';

/**
 * Supabase Storage when the S3 variables are set, otherwise in-memory storage (development and tests only:
 * `loadEnv` refuses that combination in production and demo). Files never go to the local disk either way.
 */
export function createStorage(env: StorageEnv): ObjectStorage {
  if (env.S3_ENDPOINT && env.S3_REGION && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY) {
    return new S3Storage({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      bucket: env.S3_BUCKET,
    });
  }
  if (env.APP_ENV === 'development') console.warn('S3_* is not configured: attachments are kept in memory and lost on restart.');
  return new MemoryStorage(env.S3_BUCKET);
}

export type { ObjectStorage } from './storage.js';
