import { MAX_PASSWORD_LENGTH } from '../auth/password.js';

export type SeedEnv = Record<string, string | undefined>;

export const MIN_SEED_PASSWORD_LENGTH = 12;

/** A refusal the operator can act on: wrong environment, missing confirmation, missing password. */
export class SeedGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedGuardError';
  }
}

const appEnv = (env: SeedEnv) => env.APP_ENV ?? 'development';

/** Demo data never goes into production. */
export function assertSeedAllowed(env: SeedEnv): void {
  const name = appEnv(env);
  if (!['development', 'demo', 'test'].includes(name)) throw new SeedGuardError(`Refusing to seed demo data into APP_ENV=${name}. Use development or demo.`);
}

/**
 * Resetting deletes rows and objects, so it needs three things at once: an allowed environment, the explicit
 * ALLOW_DEMO_RESET=true, and the dataset name typed twice. A production environment is always refused.
 */
export function assertResetAllowed(env: SeedEnv, args: { dataset?: string; confirm?: string }, dataset: string): void {
  const name = appEnv(env);
  if (name === 'production') throw new SeedGuardError('Refusing to reset the demo dataset in production.');
  if (!['development', 'demo'].includes(name)) throw new SeedGuardError(`Refusing to reset in APP_ENV=${name}. Use development or demo.`);
  if (env.ALLOW_DEMO_RESET !== 'true') throw new SeedGuardError('Set ALLOW_DEMO_RESET=true to allow a reset.');
  if (args.dataset !== dataset) throw new SeedGuardError(`--dataset must be exactly "${dataset}".`);
  if (args.confirm !== dataset) throw new SeedGuardError(`--confirm must repeat the dataset name ("${dataset}").`);
}

export interface SeedPasswords {
  admin?: string;
  agent?: string;
}

/** Demo account passwords come from the environment, never from the repository or the command line. */
export function seedPasswords(env: SeedEnv): SeedPasswords {
  const read = (key: string) => {
    const value = env[key];
    if (value === undefined || value === '') return undefined;
    if (value.length < MIN_SEED_PASSWORD_LENGTH || value.length > MAX_PASSWORD_LENGTH) {
      throw new SeedGuardError(`${key} must be ${MIN_SEED_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters.`);
    }
    return value;
  };
  return { admin: read('SEED_ADMIN_PASSWORD'), agent: read('SEED_AGENT_PASSWORD') };
}
