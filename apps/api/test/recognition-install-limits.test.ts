import type pg from 'pg';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/common/rate-limiting/rate-limiter.js';
import { databaseSetupClient } from './support/database-clients.js';
import { recognize, registerInstall } from './support/listener-test-kit.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

const PER_MINUTE_COUNTER = { counterName: 'recognitions-per-install-minute', maximumRequests: 3, windowSeconds: 60 };

/**
 * The per-install limits as configured (here 3 clips a minute and 5 a day), counted in the shared
 * key-value store, so two API instances give an install one allowance between them. Each request here
 * is refused for its fields after it has been counted, so no worker is needed.
 */
describe('per-install recognition limits', () => {
  let firstInstance: TestApplication;
  let secondInstance: TestApplication;
  let setupClient: pg.Client;
  const installRowIds: string[] = [];
  const clientOf = (instance: TestApplication) => () => supertest(instance.application.getHttpServer());
  const countedRequest = (instance: TestApplication, installToken: string) =>
    recognize(clientOf(instance), { installToken, fields: { codec: 'not-a-codec' } }).then((response) => response.status);

  async function newInstall(): Promise<{ installToken: string; rowId: string }> {
    const { installToken } = await registerInstall(clientOf(firstInstance));
    const rowId = JSON.parse(Buffer.from(installToken.split('.')[1] as string, 'base64url').toString('utf8')).sub as string;
    installRowIds.push(rowId);
    return { installToken, rowId };
  }

  /** As if the minute had passed: the per-minute counter of this install is cleared. */
  const startNewMinute = (rowId: string) => firstInstance.application.get(RateLimiter).clearFailures(PER_MINUTE_COUNTER, rowId);

  beforeAll(async () => {
    process.env.RECOGNITIONS_PER_INSTALL_PER_MINUTE = '3';
    process.env.RECOGNITIONS_PER_INSTALL_PER_DAY = '5';
    firstInstance = await createTestApplication();
    secondInstance = await createTestApplication();
    setupClient = databaseSetupClient();
    await setupClient.connect();
  });
  afterAll(async () => {
    await setupClient.query('DELETE FROM app.listener_installs WHERE id = ANY($1)', [installRowIds]);
    await setupClient.end();
    await Promise.all([firstInstance.close(), secondInstance.close()]);
  });

  it('applies the configured allowance: with 3 a minute, the fourth clip in a minute is the first refused', async () => {
    const { installToken } = await newInstall();
    for (let clip = 0; clip < 3; clip += 1) expect(await countedRequest(firstInstance, installToken)).toBe(400);
    const refused = await recognize(clientOf(firstInstance), { installToken });
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('RATE_LIMITED');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(refused.headers['retry-after'])).toBeLessThanOrEqual(60);
  });

  it('the daily allowance holds when the minute’s allowance is free again', async () => {
    const { installToken, rowId } = await newInstall();
    for (let clip = 0; clip < 3; clip += 1) expect(await countedRequest(firstInstance, installToken)).toBe(400);
    await startNewMinute(rowId);
    for (let clip = 0; clip < 2; clip += 1) expect(await countedRequest(firstInstance, installToken)).toBe(400);
    await startNewMinute(rowId);
    const refused = await recognize(clientOf(firstInstance), { installToken });
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('RATE_LIMITED');
    // Refused for the day, not the minute: it can try again only when the day's window ends.
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(60);
  });

  it('two API instances count one install together: its allowance is shared, not doubled', async () => {
    const { installToken } = await newInstall();
    expect(await countedRequest(firstInstance, installToken)).toBe(400);
    expect(await countedRequest(secondInstance, installToken)).toBe(400);
    expect(await countedRequest(firstInstance, installToken)).toBe(400);
    expect((await recognize(clientOf(secondInstance), { installToken })).status).toBe(429);
    expect((await recognize(clientOf(firstInstance), { installToken })).status).toBe(429);
  });
});
