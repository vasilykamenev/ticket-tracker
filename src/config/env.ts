import { z } from 'zod';

const positiveInt = (def: number) => z.coerce.number().int().positive().default(def);
/** `.env` files commonly leave a variable empty; treat that as "not set". */
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

/** Object storage (Supabase Storage through its S3 API). Without it, development uses in-memory storage. */
const storageFields = {
  S3_ENDPOINT: optional(z.url()),
  S3_REGION: optional(z.string().min(1)),
  S3_ACCESS_KEY_ID: optional(z.string().min(1)),
  S3_SECRET_ACCESS_KEY: optional(z.string().min(1)),
  S3_BUCKET: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).default('ticket-attachments')),
};
const appEnv = z.enum(['development', 'demo', 'production', 'test']).default('development');

type StorageValues = { APP_ENV: z.infer<typeof appEnv>; S3_ENDPOINT?: string; S3_REGION?: string; S3_ACCESS_KEY_ID?: string; S3_SECRET_ACCESS_KEY?: string };

/** All four S3 values or none; and a deployed environment must not silently fall back to memory storage. */
function checkStorage(env: StorageValues, ctx: z.RefinementCtx): void {
  const s3 = ['S3_ENDPOINT', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const;
  const set = s3.filter((key) => env[key] !== undefined);
  const missing = s3.filter((key) => env[key] === undefined);
  if (set.length > 0 && missing.length > 0) {
    for (const key of missing) ctx.addIssue({ code: 'custom', path: [key], message: 'required when other S3_* variables are set' });
  } else if ((env.APP_ENV === 'production' || env.APP_ENV === 'demo') && missing.length > 0) {
    for (const key of missing) ctx.addIssue({ code: 'custom', path: [key], message: 'required in a deployed environment' });
  }
}

const base = z.object({
  APP_ENV: appEnv,
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_URL: z.string().url(),
  // Number of reverse proxies in front of the app (0 = none). Set to the real hop count only.
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  DATABASE_URL: z.string().min(1),
  // PEM text of the CA that signed the database server's certificate (Supabase: Settings, Database, SSL certificate).
  DATABASE_CA_CERT: z.string().min(1).optional(),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  SESSION_IDLE_MINUTES: positiveInt(30),
  SESSION_ABSOLUTE_HOURS: positiveInt(8),
  LOGIN_WINDOW_MINUTES: positiveInt(15),
  LOGIN_MAX_PER_IP: positiveInt(20),
  LOGIN_MAX_FAILED_PER_ACCOUNT: positiveInt(5),
  ...storageFields,
  MAX_CONCURRENT_UPLOADS: positiveInt(4),
});

const schema = base.superRefine((env, ctx) => {
  checkStorage(env, ctx);
  if (env.APP_ENV !== 'production') return;
  if (new URL(env.PUBLIC_URL).protocol !== 'https:') {
    ctx.addIssue({ code: 'custom', path: ['PUBLIC_URL'], message: 'must be https in production' });
  }
  if (/CHANGE_ME/i.test(env.SESSION_SECRET)) {
    ctx.addIssue({ code: 'custom', path: ['SESSION_SECRET'], message: 'placeholder value in production' });
  }
});

/** Only what the storage scripts need, so `storage:check` does not demand a session secret. */
const storageSchema = base.pick({ APP_ENV: true, S3_ENDPOINT: true, S3_REGION: true, S3_ACCESS_KEY_ID: true, S3_SECRET_ACCESS_KEY: true, S3_BUCKET: true }).superRefine(checkStorage);

export type Env = z.infer<typeof schema>;
export type StorageEnv = z.infer<typeof storageSchema>;

function parse<T>(parser: z.ZodType<T>, source: NodeJS.ProcessEnv): T {
  const result = parser.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}

/** Validates the environment once at startup. Never echoes values, only variable names and reasons. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return parse(schema, source);
}

export function loadStorageEnv(source: NodeJS.ProcessEnv = process.env): StorageEnv {
  return parse(storageSchema, source);
}
