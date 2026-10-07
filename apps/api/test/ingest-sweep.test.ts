import { randomUUID } from 'node:crypto';
import { INGEST_QUEUE_NAME, IngestJobData } from '@lookup/contracts';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IngestSweep } from '../src/features/ads/ingest-sweep.js';
import { IngestQueue } from '../src/infrastructure/job-queues/ingest-queue.js';
import { databaseSetupClient } from './support/database-clients.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

/** The ingest sweep: ads left waiting for their fingerprints get a job again (S3-D4). */
describe('the ingest sweep', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  let queue: Queue;
  const stationId = randomUUID();
  const clientId = randomUUID();

  beforeAll(async () => {
    testApplication = await createTestApplication();
    setupClient = databaseSetupClient();
    await setupClient.connect();
    await setupClient.query(`INSERT INTO app.stations (id, name, frequency_label, status) VALUES ($1, 'Sweep test', '98.1 FM', 'ACTIVE')`, [stationId]);
    await setupClient.query(`INSERT INTO app.clients (id, station_id, name) VALUES ($1, $2, 'Brand A')`, [clientId, stationId]);
    queue = new Queue(INGEST_QUEUE_NAME, { connection: new Redis(process.env.KEY_VALUE_STORE_URL as string, { maxRetriesPerRequest: null }), prefix: process.env.QUEUE_KEY_PREFIX });
  });
  afterAll(async () => {
    await queue.close();
    await setupClient.query('DELETE FROM app.ads WHERE station_id = $1', [stationId]);
    await setupClient.query('DELETE FROM app.clients WHERE station_id = $1', [stationId]);
    await setupClient.query('DELETE FROM app.stations WHERE id = $1', [stationId]);
    await setupClient.end();
    await testApplication.close();
  });

  async function waitingAd(minutesAgo: number): Promise<string> {
    const adId = randomUUID();
    await setupClient.query(
      `INSERT INTO app.ads (id, station_id, client_id, title, status, upload_object_key, uploaded_at) VALUES ($1, $2, $3, 'Waiting', 'PROCESSING', $4, now() - make_interval(mins => $5))`,
      [adId, stationId, clientId, `ad-uploads/${stationId}/${adId}/audio`, minutesAgo],
    );
    return adId;
  }

  it('gives an ad that has waited a job with a short-lived download address and no credentials, once', async () => {
    const sweep = testApplication.application.get(IngestSweep);
    const longWaiting = await waitingAd(30);
    const justUploaded = await waitingAd(1);

    const queued = await sweep.run();
    expect(queued).toContain(longWaiting);
    expect(queued).not.toContain(justUploaded);
    const job = await queue.getJob(IngestQueue.jobIdFor(longWaiting));
    expect(IngestJobData.parse(job?.data)).toMatchObject({ ad_id: longWaiting, fingerprint_version: 1 });
    expect(job?.data.request_id).toMatch(/^ingest-sweep-/);
    expect(job?.data.download_address).toMatch(/X-Amz-Expires=1800/);
    expect(JSON.stringify(job?.data)).not.toContain(process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY as string);
    expect(job?.opts).toMatchObject({ attempts: 3, removeOnComplete: true, removeOnFail: true, backoff: { type: 'exponential', delay: 10_000 } });

    // While its job exists it is not added again; once the job is gone, not again within the cooldown.
    expect(await sweep.run()).not.toContain(longWaiting);
    await job?.remove();
    expect(await sweep.run()).not.toContain(longWaiting);
  });
});
