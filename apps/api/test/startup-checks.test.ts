import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadAppConfig } from '../src/config/app-config.js';
import { newVapidKeys } from '../src/features/notifications/web-push.js';
import { InvalidConfigurationError } from '../src/config/invalid-configuration-error.js';
import { serializeErrorForLog } from '../src/infrastructure/logging/serialize-error-for-log.js';
import { assertDatabaseRoleIsRestricted } from '../src/infrastructure/database/database-role-check.js';
import { databaseSetupClient, lookupApiClient } from './support/database-clients.js';

const rowsOf = (client: pg.Client) => ({ query: (sql: string) => client.query(sql).then((result) => result.rows) });

describe('startup refuses an unsafe database role', () => {
  let setupClient: pg.Client;
  let apiClient: pg.Client;
  beforeAll(async () => {
    setupClient = databaseSetupClient();
    apiClient = lookupApiClient();
    await setupClient.connect();
    await apiClient.connect();
  });
  afterAll(async () => {
    await setupClient.end();
    await apiClient.end();
  });

  it('rejects a superuser connection (row-level security would not apply)', async () => {
    await expect(assertDatabaseRoleIsRestricted(rowsOf(setupClient))).rejects.toThrow(/Refusing to start/);
  });

  it('accepts the restricted lookup_api role', async () => {
    await expect(assertDatabaseRoleIsRestricted(rowsOf(apiClient))).resolves.toBeUndefined();
  });
});

describe('production configuration fails closed', () => {
  const soundProductionConfig = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://lookup_api:password@database.internal:5432/lookup',
    KEY_VALUE_STORE_URL: 'redis://:password@key-value.internal:6379',
    AUTHENTICATION_SECRET: 'q4P1k5o8zXhN3wVt7RmYb2LcJ9sUeA6GdF0iHnKjTpW',
    OBJECT_STORAGE_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
    OBJECT_STORAGE_PUBLIC_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
    OBJECT_STORAGE_ACCESS_KEY_ID: 'access-key-id',
    OBJECT_STORAGE_SECRET_ACCESS_KEY: 'secret-access-key',
    OBJECT_STORAGE_AD_UPLOADS_BUCKET: 'lookup-ad-uploads',
    DATABASE_TLS_MODE: 'require',
    ALLOWED_BROWSER_ORIGINS: 'https://portal.example.com',
    LISTENER_INSTALL_TOKEN_SECRET: 'Zr7m0Qx2Lk9VpT4cWb6NyH1jS8dGfA3uEoI5aMnRtYv',
    LISTENER_INSTALL_ID_PEPPER: 'Hb3Kq8Wz1Pn6Ty4Rc9Mv2Xs7Lj5Df0Ga1Ue8Io3YtNq',
    ADMIN_DATABASE_URL: 'postgresql://lookup_admin_api:password@database.internal:5432/lookup',
    TWO_FACTOR_ENCRYPTION_SECRET: 'Tf6Ns1Qb8Kw3Jx5Pm0Vr7Ld2Hc9Gz4Ya1Ue6Wo3XiRk',
    LISTENER_EMAIL_ENCRYPTION_SECRET: 'Lm4Dq9Yx2Rb7Ws1Nk6Gv0Cj3Hf8Ta5Pe2Uo9ZiBxMsKd',
    PORTAL_PUBLIC_ORIGIN: 'https://portal.example.com',
    EMAIL_SMTP_URL: 'smtps://sender:password@smtp.example.com:465',
    EMAIL_FROM_ADDRESS: 'Look Up <no-reply@example.com>',
    SMS_SENDER: 'none',
    HUMAN_CHECK_SECRET_KEY: '0x4AAAAAAAexampleSecretKeyForTheTests',
  };

  it('accepts a sound production configuration', () => {
    expect(loadAppConfig(soundProductionConfig).ALLOWED_BROWSER_ORIGINS).toEqual(['https://portal.example.com']);
  });

  it('refuses an unencrypted database connection', () => {
    expect(() => loadAppConfig({ ...soundProductionConfig, DATABASE_TLS_MODE: 'disable' })).toThrow(
      /DATABASE_TLS_MODE: must not be "disable" in production/,
    );
    expect(() => loadAppConfig({ ...soundProductionConfig, DATABASE_TLS_MODE: undefined })).toThrow(/DATABASE_TLS_MODE/);
  });

  it('refuses a missing, short or placeholder authentication secret, in any environment', () => {
    const developmentConfig = { ...soundProductionConfig, NODE_ENV: 'development' };
    expect(() => loadAppConfig({ ...developmentConfig, AUTHENTICATION_SECRET: undefined })).toThrow(/AUTHENTICATION_SECRET/);
    expect(() => loadAppConfig({ ...developmentConfig, AUTHENTICATION_SECRET: 'too-short' })).toThrow(/AUTHENTICATION_SECRET/);
    expect(() =>
      loadAppConfig({ ...developmentConfig, AUTHENTICATION_SECRET: 'CHANGE_ME_TO_43_OR_MORE_BASE64URL_CHARACTERS_FROM_32_RANDOM_BYTES' }),
    ).toThrow(/AUTHENTICATION_SECRET: must be replaced with a random value/);
  });

  it('S3-INSTALLS-07: refuses a missing, short, placeholder or reused install-token secret or install-id pepper, never printing it', () => {
    const developmentConfig = { ...soundProductionConfig, NODE_ENV: 'development' };
    for (const secretName of ['LISTENER_INSTALL_TOKEN_SECRET', 'LISTENER_INSTALL_ID_PEPPER'] as const) {
      for (const badValue of [undefined, 'too-short-to-be-random', 'CHANGE_ME_INSTALL_SECRET_43_CHARACTERS_OR_MORE_____']) {
        let message = '';
        try {
          loadAppConfig({ ...developmentConfig, [secretName]: badValue });
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message, `${secretName}=${String(badValue)}`).toContain(secretName);
        if (badValue) expect(message).not.toContain(badValue);
      }
    }
    expect(() => loadAppConfig({ ...developmentConfig, LISTENER_INSTALL_ID_PEPPER: developmentConfig.LISTENER_INSTALL_TOKEN_SECRET })).toThrow(
      /must all be different/,
    );
    expect(() => loadAppConfig({ ...developmentConfig, LISTENER_INSTALL_TOKEN_SECRET: developmentConfig.AUTHENTICATION_SECRET })).toThrow(
      /must all be different/,
    );
  });

  it('P5A design §3.1, §5: production refuses the development SMS sender, Turnstile’s test keys, plain email, a placeholder sender and an http portal', () => {
    for (const [name, badValue, reason] of [
      ['SMS_SENDER', 'development', 'must not be "development" in production'],
      ['SMS_SENDER', undefined, 'must not be "development" in production'],
      ['HUMAN_CHECK_SECRET_KEY', '1x0000000000000000000000000000000AA', 'must not be a test key in production'],
      ['HUMAN_CHECK_SECRET_KEY', '2x0000000000000000000000000000000AA', 'must not be a test key in production'],
      ['HUMAN_CHECK_SECRET_KEY', '3x0000000000000000000000000000000AA', 'must not be a test key in production'],
      ['HUMAN_CHECK_SECRET_KEY', undefined, 'must not be a test key in production'],
      ['EMAIL_SMTP_URL', 'smtp://sender:password@smtp.example.com:587', 'must be smtps:// or require TLS in production'],
      ['EMAIL_FROM_ADDRESS', undefined, 'must be a real sending address in production'],
      ['PORTAL_PUBLIC_ORIGIN', 'http://portal.example.com', 'must be https in production'],
    ] as const) {
      expect(() => loadAppConfig({ ...soundProductionConfig, [name]: badValue }), `${name}=${String(badValue)}`).toThrow(`${name}: ${reason}`);
    }
    expect(loadAppConfig({ ...soundProductionConfig, EMAIL_SMTP_URL: 'smtp://sender:password@smtp.example.com:587', EMAIL_SMTP_REQUIRE_TLS: 'true' }).EMAIL_SMTP_REQUIRE_TLS).toBe(true);
    expect(loadAppConfig({ ...soundProductionConfig, NODE_ENV: 'development', SMS_SENDER: undefined, HUMAN_CHECK_SECRET_KEY: undefined })).toMatchObject({
      SMS_SENDER: 'development',
      HUMAN_CHECK_SECRET_KEY: '1x0000000000000000000000000000000AA',
      OBJECT_STORAGE_LICENCE_DOCUMENTS_BUCKET: 'lookup-licence-documents',
      OBJECT_STORAGE_STATION_LOGOS_BUCKET: 'lookup-station-logos',
      NOTIFICATION_SENDING_ENABLED: true,
    });
  });

  it('P5A-D19: the second-factor key is required, random and its own; the admin database address is the admin role’s own', () => {
    const developmentConfig = { ...soundProductionConfig, NODE_ENV: 'development' };
    for (const badValue of [undefined, 'too-short', 'CHANGE_ME_TWO_FACTOR_SECRET_43_CHARACTERS_OR_MORE____', developmentConfig.AUTHENTICATION_SECRET]) {
      let message = '';
      try {
        loadAppConfig({ ...developmentConfig, TWO_FACTOR_ENCRYPTION_SECRET: badValue });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, String(badValue)).toMatch(/TWO_FACTOR_ENCRYPTION_SECRET|must all be different/);
      if (badValue) expect(message).not.toContain(badValue);
    }
    expect(() => loadAppConfig({ ...developmentConfig, ADMIN_DATABASE_URL: undefined })).toThrow(/ADMIN_DATABASE_URL/);
    expect(() => loadAppConfig({ ...developmentConfig, ADMIN_DATABASE_URL: developmentConfig.DATABASE_URL })).toThrow(
      /ADMIN_DATABASE_URL: must be the super-admin role's own address/,
    );
  });

  it('LA-ROLLOUT-02: the log names a missing setting in full, even one as long as a token, and never prints a value', () => {
    // What Render's first deploy of listener accounts met: the key not added yet. Its name is 32 characters, which the
    // masking of message text takes for a token, so the log must name it in a field of its own.
    const { LISTENER_EMAIL_ENCRYPTION_SECRET: _missing, ...withoutTheKey } = soundProductionConfig;
    let refusal: unknown;
    try {
      loadAppConfig(withoutTheKey);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(InvalidConfigurationError);
    const logged = serializeErrorForLog(refusal);
    expect(logged.type).toBe('InvalidConfigurationError');
    expect(logged.settings).toEqual(['LISTENER_EMAIL_ENCRYPTION_SECRET: invalid_type']);
    const written = JSON.stringify(logged);
    for (const value of Object.values(soundProductionConfig)) expect(written).not.toContain(value);
    // A wrong value too: named, never printed.
    try {
      loadAppConfig({ ...soundProductionConfig, LISTENER_EMAIL_ENCRYPTION_SECRET: 'Not-random-but-forty-three-characters-long-x', AUTHENTICATION_SECRET: 'short' });
    } catch (error) {
      refusal = error;
    }
    const second = serializeErrorForLog(refusal);
    expect(second.settings).toEqual(['AUTHENTICATION_SECRET: invalid_format']);
    expect(JSON.stringify(second)).not.toContain('short"');
  });

  it('LA-ROLLOUT-02: the listener email key is required, random and its own, and the message never prints it', () => {
    const developmentConfig = { ...soundProductionConfig, NODE_ENV: 'development' };
    for (const badValue of [undefined, 'too-short', 'CHANGE_ME_LISTENER_EMAIL_SECRET_43_CHARACTERS_OR_MORE', developmentConfig.AUTHENTICATION_SECRET, developmentConfig.TWO_FACTOR_ENCRYPTION_SECRET, developmentConfig.LISTENER_INSTALL_ID_PEPPER]) {
      let message = '';
      try {
        loadAppConfig({ ...developmentConfig, LISTENER_EMAIL_ENCRYPTION_SECRET: badValue });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, String(badValue)).toMatch(/LISTENER_EMAIL_ENCRYPTION_SECRET|must all be different/);
      if (badValue) expect(message).not.toContain(badValue);
    }
    // In production too: the key is never optional, so a deployment cannot start without it.
    expect(() => loadAppConfig({ ...soundProductionConfig, LISTENER_EMAIL_ENCRYPTION_SECRET: undefined })).toThrow(/LISTENER_EMAIL_ENCRYPTION_SECRET/);
  });

  it('P5C-ROLLOUT-01: web push is off without its settings; given, all three come together, as a matching key pair, never printed', () => {
    const developmentConfig = { ...soundProductionConfig, NODE_ENV: 'development' };
    const withoutPush = loadAppConfig(developmentConfig);
    expect([withoutPush.WEB_PUSH_PUBLIC_KEY, withoutPush.WEB_PUSH_PRIVATE_KEY, withoutPush.WEB_PUSH_CONTACT_EMAIL]).toEqual([undefined, undefined, undefined]);
    expect(withoutPush.AIR_TIME_REMINDER_INTERVAL_SECONDS).toBe(60);
    expect(loadAppConfig({ ...developmentConfig, WEB_PUSH_PUBLIC_KEY: '', WEB_PUSH_PRIVATE_KEY: '', WEB_PUSH_CONTACT_EMAIL: '' }).WEB_PUSH_PUBLIC_KEY).toBeUndefined();
    const pair = newVapidKeys();
    const other = newVapidKeys();
    const push = { WEB_PUSH_PUBLIC_KEY: pair.publicKey, WEB_PUSH_PRIVATE_KEY: pair.privateKey, WEB_PUSH_CONTACT_EMAIL: 'push@lookup.example' };
    expect(loadAppConfig({ ...soundProductionConfig, ...push })).toMatchObject(push);
    const refusals: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...push, WEB_PUSH_CONTACT_EMAIL: undefined }, /WEB_PUSH_PUBLIC_KEY.*set all three web push settings, or none/],
      [{ ...push, WEB_PUSH_PRIVATE_KEY: other.privateKey }, /WEB_PUSH_PUBLIC_KEY.*does not belong to the private key/],
      [{ ...push, WEB_PUSH_PUBLIC_KEY: 'short' }, /WEB_PUSH_PUBLIC_KEY/],
      [{ ...push, WEB_PUSH_PRIVATE_KEY: `${pair.privateKey}x` }, /WEB_PUSH_PRIVATE_KEY/],
      [{ ...push, WEB_PUSH_CONTACT_EMAIL: 'not an email' }, /WEB_PUSH_CONTACT_EMAIL/],
      [{ AIR_TIME_REMINDER_INTERVAL_SECONDS: '5' }, /AIR_TIME_REMINDER_INTERVAL_SECONDS/],
    ];
    for (const [change, reason] of refusals) {
      let message = '';
      try {
        loadAppConfig({ ...developmentConfig, ...change });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, JSON.stringify(Object.keys(change))).toMatch(reason);
      for (const secret of [pair.privateKey, other.privateKey]) expect(message).not.toContain(secret);
    }
    expect(loadAppConfig({ ...developmentConfig, AIR_TIME_REMINDER_INTERVAL_SECONDS: '0' }).AIR_TIME_REMINDER_INTERVAL_SECONDS).toBe(0);
  });

  it('LA-ROLLOUT-01: the account gate is off unless it is switched on, and the code and creation limits have safe defaults', () => {
    const developmentConfig = { ...soundProductionConfig, NODE_ENV: 'development' };
    expect(loadAppConfig(developmentConfig)).toMatchObject({
      LISTENER_ACCOUNT_REQUIRED: false,
      LISTENER_EMAIL_CODES_PER_EMAIL_PER_HOUR: 3,
      LISTENER_EMAIL_CODES_PER_INSTALL_PER_DAY: 10,
      LISTENER_EMAIL_CODE_CHECKS_PER_INSTALL_PER_HOUR: 20,
      LISTENER_ACCOUNTS_CREATED_PER_INSTALL_PER_DAY: 5,
    });
    expect(loadAppConfig({ ...developmentConfig, LISTENER_ACCOUNT_REQUIRED: 'true' }).LISTENER_ACCOUNT_REQUIRED).toBe(true);
    expect(() => loadAppConfig({ ...developmentConfig, LISTENER_ACCOUNT_REQUIRED: 'maybe' })).toThrow(/LISTENER_ACCOUNT_REQUIRED/);
  });

  it('refuses non-https browser origins', () => {
    expect(() =>
      loadAppConfig({ ...soundProductionConfig, ALLOWED_BROWSER_ORIGINS: 'https://portal.example.com,http://portal.example.com' }),
    ).toThrow(/ALLOWED_BROWSER_ORIGINS: must all be https in production/);
  });

  it('refuses entries that are not bare origins, in any environment', () => {
    const developmentConfig = { ...soundProductionConfig, NODE_ENV: 'development' };
    expect(() => loadAppConfig({ ...developmentConfig, ALLOWED_BROWSER_ORIGINS: 'https://portal.example.com/app' })).toThrow(
      /ALLOWED_BROWSER_ORIGINS/,
    );
    expect(() => loadAppConfig({ ...developmentConfig, ALLOWED_BROWSER_ORIGINS: '*' })).toThrow(/ALLOWED_BROWSER_ORIGINS/);
  });

  it('P4 design §5.11: the follow-up allowance defaults to 60 a minute and the station-list allowance to 20 an hour, each refused out of its range', () => {
    const defaults = loadAppConfig(soundProductionConfig);
    expect(defaults.RECOGNITION_FOLLOW_UPS_PER_INSTALL_PER_MINUTE).toBe(60);
    expect(defaults.STATION_LIST_REQUESTS_PER_INSTALL_PER_HOUR).toBe(20);
    const widest = loadAppConfig({ ...soundProductionConfig, RECOGNITION_FOLLOW_UPS_PER_INSTALL_PER_MINUTE: '10000', STATION_LIST_REQUESTS_PER_INSTALL_PER_HOUR: '1000' });
    expect([widest.RECOGNITION_FOLLOW_UPS_PER_INSTALL_PER_MINUTE, widest.STATION_LIST_REQUESTS_PER_INSTALL_PER_HOUR]).toEqual([10_000, 1_000]);
    const narrowest = loadAppConfig({ ...soundProductionConfig, RECOGNITION_FOLLOW_UPS_PER_INSTALL_PER_MINUTE: '1', STATION_LIST_REQUESTS_PER_INSTALL_PER_HOUR: '1' });
    expect([narrowest.RECOGNITION_FOLLOW_UPS_PER_INSTALL_PER_MINUTE, narrowest.STATION_LIST_REQUESTS_PER_INSTALL_PER_HOUR]).toEqual([1, 1]);
    for (const [name, badValue] of [
      ['RECOGNITION_FOLLOW_UPS_PER_INSTALL_PER_MINUTE', '0'],
      ['RECOGNITION_FOLLOW_UPS_PER_INSTALL_PER_MINUTE', '10001'],
      ['RECOGNITION_FOLLOW_UPS_PER_INSTALL_PER_MINUTE', 'sixty'],
      ['STATION_LIST_REQUESTS_PER_INSTALL_PER_HOUR', '0'],
      ['STATION_LIST_REQUESTS_PER_INSTALL_PER_HOUR', '1001'],
      ['STATION_LIST_REQUESTS_PER_INSTALL_PER_HOUR', '2.5'],
    ] as const) {
      expect(() => loadAppConfig({ ...soundProductionConfig, [name]: badValue }), `${name}=${badValue}`).toThrow(new RegExp(`${name}: `));
    }
  });

  it('P4-DEFERRED-10, P4 design §5.11: the settings for clips sent later, the update gate and re-registration default to the plan’s numbers', () => {
    expect(loadAppConfig(soundProductionConfig)).toMatchObject({
      LISTENER_MINIMUM_APP_VERSION: '0.0.0',
      RECOGNITIONS_DEFERRED_PER_INSTALL_PER_HOUR: 10,
      RECOGNITION_DEFERRED_QUEUE_DEPTH_LIMIT: 20,
      RECOGNITION_DEFERRED_WAIT_MILLISECONDS: 5_000,
      RECOGNITION_DEFERRED_RETRY_AFTER_MINIMUM_SECONDS: 60,
      RECOGNITION_DEFERRED_RETRY_AFTER_MAXIMUM_SECONDS: 300,
      RECOGNITIONS_DEFERRED_IN_FLIGHT_LIMIT: 16,
      RECOGNITION_REPLAYS_PER_INSTALL_PER_HOUR: 60,
      RECOGNITION_IDEMPOTENCY_KEY_CLEAN_UP_INTERVAL_SECONDS: 86_400,
      LISTENER_REREGISTRATIONS_PER_INSTALL_PER_DAY: 5,
    });
    const changed = loadAppConfig({
      ...soundProductionConfig,
      LISTENER_MINIMUM_APP_VERSION: '1.4.2+30',
      RECOGNITIONS_DEFERRED_PER_INSTALL_PER_HOUR: '1000',
      RECOGNITION_DEFERRED_QUEUE_DEPTH_LIMIT: '50',
      RECOGNITION_DEFERRED_WAIT_MILLISECONDS: '10000',
      RECOGNITION_DEFERRED_RETRY_AFTER_MINIMUM_SECONDS: '300',
      RECOGNITION_DEFERRED_RETRY_AFTER_MAXIMUM_SECONDS: '300',
      RECOGNITIONS_DEFERRED_IN_FLIGHT_LIMIT: '31',
      RECOGNITION_REPLAYS_PER_INSTALL_PER_HOUR: '10000',
      RECOGNITION_IDEMPOTENCY_KEY_CLEAN_UP_INTERVAL_SECONDS: '0',
      LISTENER_REREGISTRATIONS_PER_INSTALL_PER_DAY: '1',
    });
    expect(changed).toMatchObject({
      LISTENER_MINIMUM_APP_VERSION: '1.4.2+30',
      RECOGNITIONS_DEFERRED_PER_INSTALL_PER_HOUR: 1_000,
      RECOGNITION_DEFERRED_QUEUE_DEPTH_LIMIT: 50,
      RECOGNITION_DEFERRED_WAIT_MILLISECONDS: 10_000,
      RECOGNITION_DEFERRED_RETRY_AFTER_MINIMUM_SECONDS: 300,
      RECOGNITION_DEFERRED_RETRY_AFTER_MAXIMUM_SECONDS: 300,
      RECOGNITIONS_DEFERRED_IN_FLIGHT_LIMIT: 31,
      RECOGNITION_REPLAYS_PER_INSTALL_PER_HOUR: 10_000,
      RECOGNITION_IDEMPOTENCY_KEY_CLEAN_UP_INTERVAL_SECONDS: 0,
      LISTENER_REREGISTRATIONS_PER_INSTALL_PER_DAY: 1,
    });
  });

  it('P4-DEFERRED-10, P4 design §5.11: each of those settings is refused out of its range, and refused when it breaks its rule against another', () => {
    for (const [name, badValue] of [
      ['LISTENER_MINIMUM_APP_VERSION', '1.0'],
      ['LISTENER_MINIMUM_APP_VERSION', '1.0.0-beta'],
      ['LISTENER_MINIMUM_APP_VERSION', 'latest'],
      ['RECOGNITIONS_DEFERRED_PER_INSTALL_PER_HOUR', '0'],
      ['RECOGNITIONS_DEFERRED_PER_INSTALL_PER_HOUR', '1001'],
      ['RECOGNITION_DEFERRED_QUEUE_DEPTH_LIMIT', '0'],
      ['RECOGNITION_DEFERRED_WAIT_MILLISECONDS', '10001'],
      ['RECOGNITION_DEFERRED_RETRY_AFTER_MINIMUM_SECONDS', '0'],
      ['RECOGNITION_DEFERRED_RETRY_AFTER_MAXIMUM_SECONDS', '3601'],
      ['RECOGNITIONS_DEFERRED_IN_FLIGHT_LIMIT', '0'],
      ['RECOGNITION_REPLAYS_PER_INSTALL_PER_HOUR', '0'],
      ['RECOGNITION_REPLAYS_PER_INSTALL_PER_HOUR', '10001'],
      ['RECOGNITION_IDEMPOTENCY_KEY_CLEAN_UP_INTERVAL_SECONDS', '-1'],
      ['LISTENER_REREGISTRATIONS_PER_INSTALL_PER_DAY', '0'],
      ['LISTENER_REREGISTRATIONS_PER_INSTALL_PER_DAY', '1001'],
    ] as const) {
      expect(() => loadAppConfig({ ...soundProductionConfig, [name]: badValue }), `${name}=${badValue}`).toThrow(new RegExp(`${name}: `));
    }
    const brokenRules: Array<[string, Record<string, string>]> = [
      ['RECOGNITION_DEFERRED_QUEUE_DEPTH_LIMIT', { RECOGNITION_QUEUE_DEPTH_LIMIT: '30', RECOGNITION_DEFERRED_QUEUE_DEPTH_LIMIT: '31' }],
      ['RECOGNITION_DEFERRED_WAIT_MILLISECONDS', { RECOGNITION_WAIT_MILLISECONDS: '3000', RECOGNITION_DEFERRED_WAIT_MILLISECONDS: '2999' }],
      ['RECOGNITION_DEFERRED_RETRY_AFTER_MAXIMUM_SECONDS', { RECOGNITION_DEFERRED_RETRY_AFTER_MINIMUM_SECONDS: '120', RECOGNITION_DEFERRED_RETRY_AFTER_MAXIMUM_SECONDS: '119' }],
      ['RECOGNITIONS_DEFERRED_IN_FLIGHT_LIMIT', { RECOGNITIONS_IN_FLIGHT_LIMIT: '8', RECOGNITIONS_DEFERRED_IN_FLIGHT_LIMIT: '8' }],
    ];
    for (const [name, values] of brokenRules) {
      expect(() => loadAppConfig({ ...soundProductionConfig, ...values }), name).toThrow(new RegExp(`${name}: `));
    }
    // At the edge of each rule the settings are taken.
    expect(() =>
      loadAppConfig({
        ...soundProductionConfig,
        RECOGNITION_QUEUE_DEPTH_LIMIT: '30',
        RECOGNITION_DEFERRED_QUEUE_DEPTH_LIMIT: '30',
        RECOGNITION_WAIT_MILLISECONDS: '3000',
        RECOGNITION_DEFERRED_WAIT_MILLISECONDS: '3000',
        RECOGNITIONS_IN_FLIGHT_LIMIT: '8',
        RECOGNITIONS_DEFERRED_IN_FLIGHT_LIMIT: '7',
      }),
    ).not.toThrow();
  });
});

describe('configuration errors never print secret values', () => {
  it('names the bad variable without echoing values', () => {
    const secretPassword = 'SuperSecretPassword123';
    const config = {
      DATABASE_URL: `postgresql://lookup_api:${secretPassword}@127.0.0.1:55432/lookup`,
      KEY_VALUE_STORE_URL: 'not a url',
    };
    expect(() => loadAppConfig(config)).toThrow(/KEY_VALUE_STORE_URL/);
    expect(() => loadAppConfig(config)).not.toThrow(new RegExp(secretPassword));
  });
});
