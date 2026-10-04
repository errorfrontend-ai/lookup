import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadAppConfig } from '../src/config/app-config.js';
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
    DATABASE_TLS_MODE: 'require',
    ALLOWED_BROWSER_ORIGINS: 'https://portal.example.com',
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
