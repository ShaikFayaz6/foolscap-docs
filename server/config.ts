import { z } from 'zod';

export const DEFAULT_DEMO_PASSWORD = 'foolscap-demo';

const flag = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((value) => value === 'true');

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  DATABASE_PATH: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // How many reverse proxies sit in front of the app. Trusting more than exist lets clients fake their IP.
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  SEED_DEMO_ACCOUNTS: flag('true'),
  DEMO_PASSWORD: z.string().min(8, 'must be at least 8 characters').default(DEFAULT_DEMO_PASSWORD),
});

/** Reads the environment once at startup, and refuses to start on a bad value. */
export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid configuration. ${problems}`);
  }
  const value = result.data;
  return {
    isProduction: value.NODE_ENV === 'production',
    port: value.PORT,
    databasePath: value.DATABASE_PATH,
    logLevel: value.LOG_LEVEL,
    trustProxy: value.TRUST_PROXY,
    seedDemoAccounts: value.SEED_DEMO_ACCOUNTS,
    demoPassword: value.DEMO_PASSWORD,
  };
}
