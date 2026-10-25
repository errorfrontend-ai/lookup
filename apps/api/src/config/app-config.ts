import { createECDH } from 'node:crypto';
import { z } from 'zod';
import { isListenerAppVersion } from '@lookup/contracts';
import { InvalidConfigurationError } from './invalid-configuration-error.js';

/** How the database connection is protected: `require` encrypts it; `verify-full` also checks the server's certificate. */
export const DATABASE_TLS_MODES = ['disable', 'require', 'verify-full'] as const;
export type DatabaseTlsMode = (typeof DATABASE_TLS_MODES)[number];

/**
 * How SMS goes out (P5A design §3.1, O16). `development` delivers each SMS as an email to the development inbox;
 * `email-stand-in` (the showcase, the user's choice of 15 October 2026) emails each SMS, marked as a stand-in, to the
 * person it is for: the applicant, or the station's owner; `none` sends none, so station sign-up stays closed. No
 * real provider is built before O16's checks are recorded, and production refuses `development`, so production can
 * never start a sign-up whose code would not arrive.
 */
export const SMS_SENDERS = ['development', 'email-stand-in', 'none'] as const;
export type SmsSenderKind = (typeof SMS_SENDERS)[number];

/** Cloudflare's published Turnstile test secrets (always pass, always fail, "already used"): never in production. */
export const HUMAN_CHECK_TEST_SECRET_KEYS = [
  '1x0000000000000000000000000000000AA',
  '2x0000000000000000000000000000000AA',
  '3x0000000000000000000000000000000AA',
] as const;

/** Dependency-injection token for the validated application configuration. */
export const APP_CONFIG = Symbol('APP_CONFIG');

/** An environment variable set to nothing reads as unset (Render and .env files can hold empty values). */
/** The P-256 public key (base64url) that belongs to a private key, or null for a value that is not one. */
function publicKeyOf(privateKey: string): string | null {
  try {
    const keys = createECDH('prime256v1');
    keys.setPrivateKey(Buffer.from(privateKey, 'base64url'));
    return keys.getPublicKey().toString('base64url');
  } catch {
    return null;
  }
}

function emptyAsUnset(value: unknown): unknown {
  return value === '' ? undefined : value;
}

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
    /** Private bucket for licence documents: uploads only, read through 5-minute links by super admins (P5A design §3.1). */
    OBJECT_STORAGE_LICENCE_DOCUMENTS_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/).default('lookup-licence-documents'),
    /** Private bucket for station logos, read through short links. */
    OBJECT_STORAGE_STATION_LOGOS_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/).default('lookup-station-logos'),

    // ---- phase 5a: sign-up, review, the super admin's second factor, the team (P5A design §3) ----------------
    /** The super-admin endpoints' own role (lookup_admin_api): never the owner or a superuser, checked at start-up. */
    ADMIN_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    /**
     * Encrypts super admins' second-factor secrets (AES-256-GCM). 32+ random bytes, base64url, different from every
     * other secret, so changing AUTHENTICATION_SECRET never locks a super admin out (P5A-D19).
     */
    TWO_FACTOR_ENCRYPTION_SECRET: z.string().regex(/^[A-Za-z0-9_-]{43,}$/),
    /** The portal's own address, for the links in emails (an email link, an invitation). */
    PORTAL_PUBLIC_ORIGIN: z.url({ protocol: /^https?$/ }).default('http://localhost:5180'),
    /** The built portal (apps/portal/dist), served from the API's own address when set (the showcase on Render). */
    PORTAL_STATIC_DIRECTORY: z.string().min(1).optional(),
    /** Where email goes out: Mailpit on this machine in development; smtps:// (or STARTTLS required) in production. */
    EMAIL_SMTP_URL: z.url({ protocol: /^smtps?$/ }).default('smtp://127.0.0.1:1025'),
    /** With an smtp:// address: refuse to send unless the server upgrades the connection to TLS, with its certificate checked. */
    EMAIL_SMTP_REQUIRE_TLS: z.stringbool().default(false),
    EMAIL_FROM_ADDRESS: z.string().min(3).max(200).default('Look Up <no-reply@lookup.invalid>'),
    SMS_SENDER: z.enum(SMS_SENDERS).default('development'),
    /** Send queued SMS and email from this process (the notify queue's worker, P5A-D9). */
    NOTIFICATION_SENDING_ENABLED: z.stringbool().default(true),
    /** The first wait before a notification is tried again; each later wait doubles (five tries in all). */
    NOTIFICATION_RETRY_DELAY_MILLISECONDS: z.coerce.number().int().min(10).max(600_000).default(30_000),
    /** The Turnstile secret key; Cloudflare's always-pass test key in development and tests (P5A-D8). */
    HUMAN_CHECK_SECRET_KEY: z.string().min(1).max(200).default(HUMAN_CHECK_TEST_SECRET_KEYS[0]),

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

    // ---- clips sent later, the update gate and re-registration (P4 design §5.2, §5.3, §5.7, §5.11) -------
    /**
     * The oldest listener app version still served; an install registered below it gets 426 APP_UPDATE_REQUIRED on
     * every install-token route. "0.0.0" switches the gate off.
     */
    LISTENER_MINIMUM_APP_VERSION: z
      .string()
      .default('0.0.0')
      .refine(isListenerAppVersion, 'must be a version such as 1.2.3'),
    /** Clips the outbox sends later (is_deferred "true"), per install per hour: their own allowance, apart from live clips. */
    RECOGNITIONS_DEFERRED_PER_INSTALL_PER_HOUR: z.coerce.number().int().min(1).max(1_000).default(10),
    /** Waiting clips past which a deferred send is refused (503); below the live limit, so deferred sends are shed first. */
    RECOGNITION_DEFERRED_QUEUE_DEPTH_LIMIT: z.coerce.number().int().min(1).max(100_000).default(20),
    /** How long a deferred send waits for its worker (and its job's deadline). */
    RECOGNITION_DEFERRED_WAIT_MILLISECONDS: z.coerce.number().int().min(500).max(10_000).default(5_000),
    /** A deferred send refused with 503 is told to come back after a random whole number of seconds in this range. */
    RECOGNITION_DEFERRED_RETRY_AFTER_MINIMUM_SECONDS: z.coerce.number().int().min(1).max(3_600).default(60),
    RECOGNITION_DEFERRED_RETRY_AFTER_MAXIMUM_SECONDS: z.coerce.number().int().min(1).max(3_600).default(300),
    /** The places in flight a deferred send may take, inside RECOGNITIONS_IN_FLIGHT_LIMIT, so live clips always keep some. */
    RECOGNITIONS_DEFERRED_IN_FLIGHT_LIMIT: z.coerce.number().int().min(1).max(9_999).default(16),
    /** Sends of an idempotency key the server already holds, per install per hour: resends after a lost answer, a 409 or a 503. */
    RECOGNITION_REPLAYS_PER_INSTALL_PER_HOUR: z.coerce.number().int().min(1).max(10_000).default(60),
    /** How often expired idempotency keys are deleted; 0 switches the job off (tests). */
    RECOGNITION_IDEMPOTENCY_KEY_CLEAN_UP_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(7 * 86_400).default(86_400),
    /** Registrations of an install that carry its own valid token (after an app update), per install per day. */
    LISTENER_REREGISTRATIONS_PER_INSTALL_PER_DAY: z.coerce.number().int().min(1).max(1_000).default(5),
    /**
     * Taps one install may count toward one campaign's tap limit in 24 hours (P4 design §5.8, P4-D10, Q12): more taps
     * are stored, never counted, so one phone cannot use up a campaign's limit. 0 switches the cap off.
     */
    ENGAGEMENTS_COUNTED_PER_INSTALL_PER_CAMPAIGN_PER_DAY: z.coerce.number().int().min(0).max(1_000).default(5),
    /** Signs install tokens. 32+ random bytes, base64url. Changing it makes every app register again. */
    LISTENER_INSTALL_TOKEN_SECRET: z.string().regex(/^[A-Za-z0-9_-]{43,}$/),
    /** Keys the hash of an app's install id, so the raw id is never stored. 32+ random bytes, base64url. */
    LISTENER_INSTALL_ID_PEPPER: z.string().regex(/^[A-Za-z0-9_-]{43,}$/),

    // ---- listener accounts (ADR-005, docs/design/listener-accounts.md) -----------------------------------------
    /**
     * Whether the result of an ad scan waits for the listener to create an account. Off by default: the account
     * routes work either way, but nothing is held back until this is turned on (the rollout order of design §8).
     */
    LISTENER_ACCOUNT_REQUIRED: z.stringbool().default(false),
    /**
     * Seals listeners' emails (AES-256-GCM) and keys the hash they are found by. 32+ random bytes, base64url, different
     * from every other secret. Losing or changing it makes every stored email unreadable and every account unfindable,
     * so it is kept like a database backup key and never rotated casually.
     */
    LISTENER_EMAIL_ENCRYPTION_SECRET: z.string().regex(/^[A-Za-z0-9_-]{43,}$/),
    /** Codes sent to one email address per hour, whatever install asks: bounds mail to a victim's inbox (LA-ROUTES-02). */
    LISTENER_EMAIL_CODES_PER_EMAIL_PER_HOUR: z.coerce.number().int().min(1).max(100).default(3),
    /** Codes one install may ask for per day: installs are cheap, so this is a nuisance limit, not an abuse control. */
    LISTENER_EMAIL_CODES_PER_INSTALL_PER_DAY: z.coerce.number().int().min(1).max(1_000).default(10),
    /** Codes one install may check per hour, on top of a code locking after 5 wrong tries. */
    LISTENER_EMAIL_CODE_CHECKS_PER_INSTALL_PER_HOUR: z.coerce.number().int().min(1).max(1_000).default(20),
    /** Accounts one install may create per day. */
    LISTENER_ACCOUNTS_CREATED_PER_INSTALL_PER_DAY: z.coerce.number().int().min(1).max(1_000).default(5),
    /**
     * Web Push for clients' reminders (ADR-006): the server's VAPID key pair (P-256: the public key's 65 bytes and the
     * private key's 32, in base64url) and the address push services may write to. All three or none: without them push is
     * off and reminders go by email. An empty value counts as unset.
     */
    WEB_PUSH_PUBLIC_KEY: z.preprocess(emptyAsUnset, z.string().regex(/^[A-Za-z0-9_-]{87}$/).optional()),
    WEB_PUSH_PRIVATE_KEY: z.preprocess(emptyAsUnset, z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional()),
    WEB_PUSH_CONTACT_EMAIL: z.preprocess(emptyAsUnset, z.email().max(254).optional()),
    /** How often the air-time reminder job looks for slots about to start; 0 switches it off (tests run it by hand). */
    AIR_TIME_REMINDER_INTERVAL_SECONDS: z.coerce
      .number()
      .int()
      .min(0)
      .max(600)
      .default(60)
      .refine((seconds) => seconds === 0 || seconds >= 10, { message: 'must be 0 (off) or at least 10 seconds' }),
  })
  .superRefine((config, context) => {
    // The template's placeholder has the right shape, so refuse it by name in every environment.
    for (const secretName of ['AUTHENTICATION_SECRET', 'LISTENER_INSTALL_TOKEN_SECRET', 'LISTENER_INSTALL_ID_PEPPER', 'TWO_FACTOR_ENCRYPTION_SECRET', 'LISTENER_EMAIL_ENCRYPTION_SECRET'] as const) {
      if (config[secretName].includes('CHANGE_ME')) {
        context.addIssue({ code: 'custom', path: [secretName], message: 'must be replaced with a random value' });
      }
    }
    const secrets = [
      config.AUTHENTICATION_SECRET,
      config.LISTENER_INSTALL_TOKEN_SECRET,
      config.LISTENER_INSTALL_ID_PEPPER,
      config.TWO_FACTOR_ENCRYPTION_SECRET,
      config.LISTENER_EMAIL_ENCRYPTION_SECRET,
    ];
    if (new Set(secrets).size < secrets.length) {
      context.addIssue({ code: 'custom', path: ['LISTENER_INSTALL_TOKEN_SECRET'], message: 'the secrets must all be different' });
    }
    const webPushSettingsGiven = [config.WEB_PUSH_PUBLIC_KEY, config.WEB_PUSH_PRIVATE_KEY, config.WEB_PUSH_CONTACT_EMAIL].filter((value) => value !== undefined).length;
    if (webPushSettingsGiven !== 0 && webPushSettingsGiven !== 3) {
      context.addIssue({ code: 'custom', path: ['WEB_PUSH_PUBLIC_KEY'], message: 'set all three web push settings, or none' });
    }
    if (config.WEB_PUSH_PUBLIC_KEY && config.WEB_PUSH_PRIVATE_KEY && publicKeyOf(config.WEB_PUSH_PRIVATE_KEY) !== config.WEB_PUSH_PUBLIC_KEY) {
      context.addIssue({ code: 'custom', path: ['WEB_PUSH_PUBLIC_KEY'], message: 'the web push public key does not belong to the private key' });
    }
    if (config.ADMIN_DATABASE_URL === config.DATABASE_URL) {
      context.addIssue({ code: 'custom', path: ['ADMIN_DATABASE_URL'], message: "must be the super-admin role's own address" });
    }
    if (config.RECOGNITIONS_PER_INSTALL_PER_DAY < config.RECOGNITIONS_PER_INSTALL_PER_MINUTE) {
      context.addIssue({ code: 'custom', path: ['RECOGNITIONS_PER_INSTALL_PER_DAY'], message: 'must be at least the per-minute limit' });
    }
    if (config.LISTENER_REQUESTS_PER_CLIENT_ADDRESS_PER_MINUTE < 10 * config.RECOGNITIONS_PER_INSTALL_PER_MINUTE) {
      context.addIssue({ code: 'custom', path: ['LISTENER_REQUESTS_PER_CLIENT_ADDRESS_PER_MINUTE'], message: "must be at least ten installs' worth" });
    }
    if (config.RECOGNITION_DEFERRED_QUEUE_DEPTH_LIMIT > config.RECOGNITION_QUEUE_DEPTH_LIMIT) {
      context.addIssue({ code: 'custom', path: ['RECOGNITION_DEFERRED_QUEUE_DEPTH_LIMIT'], message: 'must not be above the live queue depth limit' });
    }
    if (config.RECOGNITION_DEFERRED_WAIT_MILLISECONDS < config.RECOGNITION_WAIT_MILLISECONDS) {
      context.addIssue({ code: 'custom', path: ['RECOGNITION_DEFERRED_WAIT_MILLISECONDS'], message: 'must be at least the live wait' });
    }
    if (config.RECOGNITION_DEFERRED_RETRY_AFTER_MAXIMUM_SECONDS < config.RECOGNITION_DEFERRED_RETRY_AFTER_MINIMUM_SECONDS) {
      context.addIssue({ code: 'custom', path: ['RECOGNITION_DEFERRED_RETRY_AFTER_MAXIMUM_SECONDS'], message: 'must be at least the minimum' });
    }
    if (config.RECOGNITIONS_DEFERRED_IN_FLIGHT_LIMIT >= config.RECOGNITIONS_IN_FLIGHT_LIMIT) {
      context.addIssue({ code: 'custom', path: ['RECOGNITIONS_DEFERRED_IN_FLIGHT_LIMIT'], message: 'must leave live clips at least one place' });
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
    if (!config.PORTAL_PUBLIC_ORIGIN.startsWith('https://')) {
      context.addIssue({ code: 'custom', path: ['PORTAL_PUBLIC_ORIGIN'], message: 'must be https in production' });
    }
    if (!config.EMAIL_SMTP_URL.startsWith('smtps://') && !config.EMAIL_SMTP_REQUIRE_TLS) {
      context.addIssue({ code: 'custom', path: ['EMAIL_SMTP_URL'], message: 'must be smtps:// or require TLS in production' });
    }
    if (/\.invalid>?$/.test(config.EMAIL_FROM_ADDRESS)) {
      context.addIssue({ code: 'custom', path: ['EMAIL_FROM_ADDRESS'], message: 'must be a real sending address in production' });
    }
    if (config.SMS_SENDER === 'development') {
      context.addIssue({ code: 'custom', path: ['SMS_SENDER'], message: 'must not be "development" in production' });
    }
    if ((HUMAN_CHECK_TEST_SECRET_KEYS as readonly string[]).includes(config.HUMAN_CHECK_SECRET_KEY)) {
      context.addIssue({ code: 'custom', path: ['HUMAN_CHECK_SECRET_KEY'], message: 'must not be a test key in production' });
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
    throw new InvalidConfigurationError(problems);
  }
  return parsed.data;
}
