import { z } from 'zod';

/** Dependency-injection token for the validated application configuration. */
export const APP_CONFIG = Symbol('APP_CONFIG');

/** Comma-separated list of exact browser origins, e.g. "https://portal.example.com". */
const BrowserOrigins = z
  .string()
  .transform((list) => list.split(',').map((origin) => origin.trim()).filter(Boolean))
  .pipe(
    z
      .array(
        z.string().refine((origin) => URL.canParse(origin) && new URL(origin).origin === origin, 'each entry must be a bare origin'),
      )
      .min(1),
  );

const AppConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3100),

    /** The API's own role (lookup_api): never the owner or a superuser — the startup check enforces it. */
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    DATABASE_STATEMENT_TIMEOUT_MILLISECONDS: z.coerce.number().int().min(100).max(60_000).default(5_000),
    /** `require` encrypts the connection; `verify-full` also checks the server's certificate. */
    DATABASE_TLS_MODE: z.enum(['disable', 'require', 'verify-full']).default('disable'),

    /** Valkey: job queues, rate-limit counters and short-lived codes. */
    KEY_VALUE_STORE_URL: z.url({ protocol: /^rediss?$/ }),

    /**
     * At least 32 random bytes, base64url-encoded (43+ characters). Keys for signing access tokens,
     * trusted-device cookies and hashing identifiers in logs are derived from it. Changing it signs
     * everyone out.
     */
    AUTHENTICATION_SECRET: z.string().regex(/^[A-Za-z0-9_-]{43,}$/),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    /** Full request details in logs; off by default so customer data never reaches logs by accident. */
    LOG_REQUEST_DETAILS: z.stringbool().default(false),

    /** Browser origins allowed to call the API with cookies (the portal). */
    ALLOWED_BROWSER_ORIGINS: BrowserOrigins.default(['http://localhost:5180']),
    /** Proxies in front of the API. Too high a number lets clients fake their address and dodge rate limits. */
    TRUSTED_PROXY_COUNT: z.coerce.number().int().min(0).max(5).default(1),
    /** Baseline requests per client address per minute, on every route. */
    RATE_LIMIT_REQUESTS_PER_MINUTE: z.coerce.number().int().min(10).max(100_000).default(300),
  })
  .superRefine((config, context) => {
    // The template's placeholder has the right shape, so refuse it by name in every environment.
    if (config.AUTHENTICATION_SECRET.includes('CHANGE_ME')) {
      context.addIssue({ code: 'custom', path: ['AUTHENTICATION_SECRET'], message: 'must be replaced with a random value' });
    }
    if (config.NODE_ENV !== 'production') return;
    if (config.DATABASE_TLS_MODE === 'disable') {
      context.addIssue({ code: 'custom', path: ['DATABASE_TLS_MODE'], message: 'must not be "disable" in production' });
    }
    if (config.ALLOWED_BROWSER_ORIGINS.some((origin) => !origin.startsWith('https://'))) {
      context.addIssue({ code: 'custom', path: ['ALLOWED_BROWSER_ORIGINS'], message: 'must all be https in production' });
    }
  });

export type AppConfig = z.infer<typeof AppConfigSchema>;

/**
 * Validate configuration once at startup and fail closed. Error text names the variables and
 * what is wrong with them — never their values, which may be secrets.
 */
export function loadAppConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = AppConfigSchema.safeParse(source);
  if (!parsed.success) {
    // Our own rule messages are safe to print; zod's built-in messages can quote the input.
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.code === 'custom' ? issue.message : issue.code}`,
    );
    throw new Error(`Invalid configuration — ${problems.join('; ')}`);
  }
  return parsed.data;
}
