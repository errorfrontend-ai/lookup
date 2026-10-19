import { randomUUID } from 'node:crypto';
import { LISTENER_CONSENT_TEXT_VERSION } from '@lookup/contracts';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InstallTokens } from '../src/common/listener-authentication/install-tokens.js';
import { APP_CONFIG, type AppConfig, loadAppConfig } from '../src/config/app-config.js';
import { EMAIL_SENDER, type EmailSender, type OutgoingEmail } from '../src/features/notifications/notification-senders.js';
import { ListenerAccountRecords } from '../src/features/listener-accounts/listener-account-records.js';
import { KEY_VALUE_STORE } from '../src/infrastructure/key-value-store/key-value-store.module.js';
import { databaseSetupClient } from './support/database-clients.js';
import { assertErrorEnvelope, INTERNAL_DETAIL_PATTERNS } from './support/internal-detail-patterns.js';
import { randomClientAddress, registerInstall } from './support/listener-test-kit.js';
import { waitForLogWrites } from './support/log-capture.js';
import { switchableKeyValueStore } from './support/switchable-key-value-store.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

class RecordingEmailSender implements EmailSender {
  readonly sent: OutgoingEmail[] = [];
  async send(email: OutgoingEmail): Promise<void> {
    this.sent.push(email);
  }
}

/**
 * The listener's account routes when what they depend on fails (ADR-005; LA-ROUTES-02, -03): with the counter and code
 * store down they refuse with 503 in the error envelope and send no code, never allowing unlimited codes or guesses; a
 * database function that fails answers a plain 500 with the request id and nothing of the driver, the table or the
 * listener.
 */
describe('listener account routes when the key-value store or the database fails', () => {
  let testApplication: TestApplication;
  let switchState: { isDown: boolean };
  const failingRecords = { isFailing: false };
  /** The database functions, answering nothing, or failing the way a driver does: with the SQLSTATE, the table and the constraint. */
  const fail = async (): Promise<never> => {
    throw Object.assign(new Error('duplicate key value violates unique constraint "listener_accounts_email_hash_unique" on relation "app.listener_accounts"'), {
      code: '23505',
      constraint: 'listener_accounts_email_hash_unique',
      table: 'listener_accounts',
    });
  };
  const recordsThatCanFail = {
    describeAccountOfInstall: async () => (failingRecords.isFailing ? fail() : null),
    unlinkInstall: async () => (failingRecords.isFailing ? fail() : 'NOT_LINKED'),
    deleteAccountOfInstall: async () => (failingRecords.isFailing ? fail() : 'NO_ACCOUNT'),
    linkInstallToExistingAccount: async () => (failingRecords.isFailing ? fail() : 'NO_ACCOUNT'),
    createAccountAndLinkInstall: async () => (failingRecords.isFailing ? fail() : 'NO_INSTALL'),
  };
  const emails = new RecordingEmailSender();
  const client = () => supertest(testApplication.application.getHttpServer());
  const installHashes: Buffer[] = [];
  const asInstall = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Forwarded-For': randomClientAddress() });

  beforeAll(async () => {
    const config: AppConfig = { ...loadAppConfig(), NOTIFICATION_SENDING_ENABLED: true, NOTIFICATION_RETRY_DELAY_MILLISECONDS: 20 };
    testApplication = await createTestApplication({
      overrideProviders: (builder) =>
        builder
          .overrideProvider(APP_CONFIG)
          .useValue(config)
          .overrideProvider(EMAIL_SENDER)
          .useValue(emails)
          .overrideProvider(KEY_VALUE_STORE)
          .useFactory({
            inject: [APP_CONFIG],
            factory: (appConfig: AppConfig) => {
              const switchable = switchableKeyValueStore(appConfig);
              switchState = switchable.switchState;
              return switchable.store;
            },
          })
          .overrideProvider(ListenerAccountRecords)
          .useValue(recordsThatCanFail),
    });
  });
  afterAll(async () => {
    switchState.isDown = false;
    const setupClient = databaseSetupClient();
    await setupClient.connect();
    await setupClient.query('DELETE FROM app.listener_installs WHERE install_id_hash = ANY($1)', [installHashes]);
    await setupClient.end();
    await testApplication.close();
  });

  async function newInstall() {
    const install = await registerInstall(client);
    installHashes.push(testApplication.application.get(InstallTokens).hashInstallId(install.installId));
    return install;
  }

  it('LA-ROUTES-02: asking for, checking and creating with a code store that is down answer 503 in the error envelope, and no code goes out', async () => {
    const { installToken } = await newInstall();
    const email = `down.${randomUUID().slice(0, 8)}@example.com`;
    switchState.isDown = true;
    try {
      const requests = [
        client().post('/api/v1/listener-account/code').set(asInstall(installToken)).send({ email }),
        client().post('/api/v1/listener-account/verify').set(asInstall(installToken)).send({ email, code: '123456' }),
        client()
          .post('/api/v1/listener-account')
          .set(asInstall(installToken))
          .send({ email, ticket: 'A'.repeat(54), gender: 'MALE', age: 30, consent_text_version: LISTENER_CONSENT_TEXT_VERSION }),
      ];
      for (const response of await Promise.all(requests)) {
        expect(response.status).toBe(503);
        expect(assertErrorEnvelope(response.body).error.code).toBe('SERVICE_UNAVAILABLE');
      }
    } finally {
      switchState.isDown = false;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(emails.sent.filter((sent) => sent.to === email)).toEqual([]);
  });

  it('LA-ROUTES-03: a database function that fails answers a plain 500 with the request id, and the log has the detail but not the listener', async () => {
    const { installToken } = await newInstall();
    const email = `failing.${randomUUID().slice(0, 8)}@example.com`;
    failingRecords.isFailing = true;
    try {
      const responses = [
        await client().get('/api/v1/listener-account').set(asInstall(installToken)),
        await client().post('/api/v1/listener-account/sign-out').set(asInstall(installToken)),
        await client().delete('/api/v1/listener-account').set(asInstall(installToken)),
      ];
      for (const response of responses) {
        expect(response.status).toBe(500);
        const envelope = assertErrorEnvelope(response.body);
        expect(envelope.error.code).toBe('INTERNAL');
        expect(envelope.error.request_id.length).toBeGreaterThan(0);
        for (const pattern of INTERNAL_DETAIL_PATTERNS) expect(JSON.stringify(response.body)).not.toMatch(pattern);
        expect(JSON.stringify(response.body)).not.toMatch(/listener_accounts|23505|unique/);
      }
    } finally {
      failingRecords.isFailing = false;
    }
    await waitForLogWrites();
    expect(testApplication.logs.lines.filter((line) => line.level === 50).length).toBeGreaterThan(0);
    expect(JSON.stringify(testApplication.logs.lines)).not.toContain(email);
  });
});
