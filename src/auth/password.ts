import argon2 from 'argon2';

// OWASP minimum for Argon2id: m=19 MiB, t=2, p=1. Tuned values are documented in the README.
const options = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const MAX_PASSWORD_LENGTH = 256;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, options);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;
/**
 * Hash verified when the email is unknown, so unknown-email and wrong-password
 * take the same time and return the same error.
 */
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(`dummy-${Math.random()}-${Date.now()}`);
  return dummyHash;
}
