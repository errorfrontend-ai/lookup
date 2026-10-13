import { z } from 'zod';

/** How the database connection is protected: `require` encrypts it; `verify-full` also checks the server's certificate. */
export const DATABASE_TLS_MODES = ['disable', 'require', 'verify-full'] as const;
export type DatabaseTlsMode = (typeof DATABASE_TLS_MODES)[number];

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
    DATABASE_TLS_MODE: z.enum(DATABASE_TLS_MODES).default('disable'),

    /** Valkey: job queues, rate-limit counters and short-lived codes. */
    KEY_VALUE_STORE_URL: z.url({ protocol: /^rediss?$/ }),

    /**
     * At least 32 random bytes, base64url-encoded (43+ characters). Keys for signing access tokens,
     * trusted-device cookies and hashing identifiers in logs are derived from it. Changing it signs
     * everyone out.
     */
    AUTHENTICATION_SECRET: z.string().regex(/^[A-Za-z0-9_-]{43,}$/),

    /** How the API reaches object storage (R2's S3 endpoint in production). */
    OBJECT_STORAGE_ENDPOINT: z.url({ protocol: /^https?$/ }),
    /** What browsers reach; presigned upload and playback URLs are signed for this host. */
    OBJECT_STORAGE_PUBLIC_ENDPOINT: z.url({ protocol: /^https?$/ }),
    /** "auto" on R2. */
    OBJECT_STORAGE_REGION: z.string().min(1).default('auto'),
    OBJECT_STORAGE_ACCESS_KEY_ID: z.string().min(1),
    OBJECT_STORAGE_SECRET_ACCESS_KEY: z.string().min(1),
    /** Private bucket for uploaded ad audio. */
    OBJECT_STORAGE_AD_UPLOADS_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    /** Full request details in logs; off by default so customer data never reaches logs by accident. */
    LOG_REQUEST_DETAILS: z.stringbool().default(false),

    /** Browser origins allowed to call the API with cookies (the portal). */
    ALLOWED_BROWSER_ORIGINS: BrowserOrigins.default(['http://localhost:5180']),
    /** Proxies in front of the API. Too high a number lets clients fake their address and dodge rate limits. */
    TRUSTED_PROXY_COUNT: z.coerce.number().int().min(0).max(5).default(1),
    /** Baseline requests per client address per minute, on every route except the listener app's. */
    RATE_LIMIT_REQUESTS_PER_MINUTE: z.coerce.number().int().min(10).max(100_000).default(300),

    // ---- the listener app and recognition (Step 3, docs/design/step-3-engine-hookup.md) -------------
    /** Prefix of every BullMQ key in Valkey; the workers must use the same one. */
    QUEUE_KEY_PREFIX: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/).default('lookup'),
    /** The fingerprint settings the workers run (ADR-001); jobs for another version are refused. */
    FINGERPRINT_VERSION: z.coerce.number().int().min(1).max(32_767).default(2),
    /** How often ads left waiting for fingerprints get their ingest job again; 0 switches the sweep off. */
    INGEST_SWEEP_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(3_600).default(60),
    /** How long a live recognition waits for its worker before answering 503 RECOGNITION_TIMEOUT. */
    RECOGNITION_WAIT_MILLISECONDS: z.coerce.number().int().min(500).max(10_000).default(2_500),
    /** Clips waiting in the recognize queue past which new ones are refused at once (503 RECOGNITION_BUSY). */
    RECOGNITION_QUEUE_DEPTH_LIMIT: z.coerce.number().int().min(1).max(100_000).default(50),
    /** Per install (not per address: many listeners share one mobile-network address). */
    RECOGNITIONS_PER_INSTALL_PER_MINUTE: z.coerce.number().int().min(1).max(1_000).default(6),
    RECOGNITIONS_PER_INSTALL_PER_DAY: z.coerce.number().int().min(1).max(100_000).default(60),
    /** Installs registered from one address per hour: registration is once per phone, so this is strict. */
    LISTENER_REGISTRATIONS_PER_CLIENT_ADDRESS_PER_HOUR: z.coerce.number().int().min(1).max(100_000).default(60),
    /** Clips from one address per minute, whatever install sends them: installs cost nothing to make, so this stops one sender filling the queue. */
    RECOGNITIONS_PER_CLIENT_ADDRESS_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(300),
    /** Recognitions this API instance works on at once (reading the clip included): past it, 503 at once. Bounds the memory clips can hold. */
    RECOGNITIONS_IN_FLIGHT_LIMIT: z.coerce.number().int().min(1).max(10_000).default(32),
    /** How long a clip may take to arrive once its request has started. */
    RECOGNIZE_BODY_READ_MILLISECONDS: z.coerce.number().int().min(500).max(55_000).default(20_000),
    /** The only per-address limit on the listener routes: a high ceiling, many installs' worth. */
    LISTENER_REQUESTS_PER_CLIENT_ADDRESS_PER_MINUTE: z.coerce.number().int().min(10).max(1_000_000).default(600),
    /**
     * What one install sends after an answer — station choices, button taps and reports — shares one allowance per
     * minute (P4 design §5.11, P4-D29). The outbox sends these in bursts after a phone comes back online.
     */
    RECOGNITION_FOLLOW_UPS_PER_INSTALL_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(60),
    /** "My station" list requests per install per hour: the app keeps the list for 24 hours, so a few are plenty. */
    STATION_LIST_REQUESTS_PER_INSTALL_PER_HOUR: z.coerce.number().int().min(1).max(1_000).default(20),
    /** Signs install tokens. 32+ random bytes, base64url. Changing it makes every app register again. */
    LISTENER_INSTALL_TOKEN_SECRET: z.string().regex(/^[A-Za-z0-9_-]{43,}$/),
    /** Keys the hash of an app's install id, so the raw id is never stored. 32+ random bytes, base64url. */
    LISTENER_INSTALL_ID_PEPPER: z.string().regex(/^[A-Za-z0-9_-]{43,}$/),
  })
  .superRefine((config, context) => {
    // The template's placeholder has the right shape, so refuse it by name in every environment.
    for (const secretName of ['AUTHENTICATION_SECRET', 'LISTENER_INSTALL_TOKEN_SECRET', 'LISTENER_INSTALL_ID_PEPPER'] as const) {
      if (config[secretName].includes('CHANGE_ME')) {
        context.addIssue({ code: 'custom', path: [secretName], message: 'must be replaced with a random value' });
      }
    }
    if (new Set([config.AUTHENTICATION_SECRET, config.LISTENER_INSTALL_TOKEN_SECRET, config.LISTENER_INSTALL_ID_PEPPER]).size < 3) {
      context.addIssue({ code: 'custom', path: ['LISTENER_INSTALL_TOKEN_SECRET'], message: 'the three secrets must all be different' });
    }
    if (config.RECOGNITIONS_PER_INSTALL_PER_DAY < config.RECOGNITIONS_PER_INSTALL_PER_MINUTE) {
      context.addIssue({ code: 'custom', path: ['RECOGNITIONS_PER_INSTALL_PER_DAY'], message: 'must be at least the per-minute limit' });
    }
    if (config.LISTENER_REQUESTS_PER_CLIENT_ADDRESS_PER_MINUTE < 10 * config.RECOGNITIONS_PER_INSTALL_PER_MINUTE) {
      context.addIssue({ code: 'custom', path: ['LISTENER_REQUESTS_PER_CLIENT_ADDRESS_PER_MINUTE'], message: "must be at least ten installs' worth" });
    }
    if (config.NODE_ENV !== 'production') return;
    if (config.DATABASE_TLS_MODE === 'disable') {
      context.addIssue({ code: 'custom', path: ['DATABASE_TLS_MODE'], message: 'must not be "disable" in production' });
    }
    for (const endpointName of ['OBJECT_STORAGE_ENDPOINT', 'OBJECT_STORAGE_PUBLIC_ENDPOINT'] as const) {
      if (!config[endpointName].startsWith('https://')) {
        context.addIssue({ code: 'custom', path: [endpointName], message: 'must be https in production' });
      }
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
