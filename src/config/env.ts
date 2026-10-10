import { z } from 'zod';

const positiveInt = (def: number) => z.coerce.number().int().positive().default(def);

const schema = z
  .object({
    APP_ENV: z.enum(['development', 'demo', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    PUBLIC_URL: z.string().url(),
    // Number of reverse proxies in front of the app (0 = none). Set to the real hop count only.
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    DATABASE_URL: z.string().min(1),
    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
    SESSION_IDLE_MINUTES: positiveInt(30),
    SESSION_ABSOLUTE_HOURS: positiveInt(8),
    LOGIN_WINDOW_MINUTES: positiveInt(15),
    LOGIN_MAX_PER_IP: positiveInt(20),
    LOGIN_MAX_FAILED_PER_ACCOUNT: positiveInt(5),
  })
  .superRefine((env, ctx) => {
    if (env.APP_ENV !== 'production') return;
    if (new URL(env.PUBLIC_URL).protocol !== 'https:') {
      ctx.addIssue({ code: 'custom', path: ['PUBLIC_URL'], message: 'must be https in production' });
    }
    if (/CHANGE_ME/i.test(env.SESSION_SECRET)) {
      ctx.addIssue({ code: 'custom', path: ['SESSION_SECRET'], message: 'placeholder value in production' });
    }
  });

export type Env = z.infer<typeof schema>;

/** Validates the environment once at startup. Never echoes values, only variable names and reasons. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}
