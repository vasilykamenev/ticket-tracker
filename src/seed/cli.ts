import { loadStorageEnv } from '../config/env.js';
import { createStorage } from '../storage/index.js';
import { MemoryStorage } from '../storage/memory-storage.js';
import type { ObjectStorage } from '../storage/storage.js';
import { SeedGuardError } from './config.js';

/**
 * The real object storage. Demo attachments in memory would vanish with the process and leave database rows that
 * point at nothing, so a missing S3 configuration is refused instead of silently falling back.
 */
export function openSeedStorage(): ObjectStorage {
  const storage = createStorage(loadStorageEnv());
  if (storage instanceof MemoryStorage) {
    throw new SeedGuardError('The demo attachments must really be stored: set S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY (see .env.example).');
  }
  return storage;
}

/** Runs a CLI entry point: operator mistakes print a short message, anything else keeps its stack. */
export async function runCli(main: () => Promise<number | void>): Promise<void> {
  try {
    process.exitCode = (await main()) ?? 0;
  } catch (err) {
    if (err instanceof SeedGuardError) {
      console.error(err.message);
      process.exitCode = 1;
    } else {
      console.error(err);
      process.exitCode = 2;
    }
  }
}

export function parseSeedNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new SeedGuardError(`Not a valid non-negative integer: ${value}`);
  return n;
}
