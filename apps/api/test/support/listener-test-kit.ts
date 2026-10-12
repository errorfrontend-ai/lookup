import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RECOGNIZE_QUEUE_NAME, type RecognizeJobData, type RecognizeJobResult } from '@lookup/contracts';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type pg from 'pg';
import supertest from 'supertest';
import { workerHeartbeatKey } from '../../src/infrastructure/job-queues/worker-heartbeat-key.js';

// ---- requests the listener app makes ------------------------------------------------------------

/**
 * A made-up client address. Each test request comes from its own unless the test is about addresses:
 * the per-address counters live in Valkey and outlast a test file, so a shared 127.0.0.1 would soon
 * run into them.
 */
export const randomClientAddress = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

export async function registerInstall(client: () => supertest.Agent, installId: string = randomUUID()) {
  const response = await client()
    .post('/api/v1/installs')
    .set('X-Forwarded-For', randomClientAddress())
    .send({ install_id: installId, platform: 'ANDROID', app_version: '1.0.0' });
  if (response.status !== 200) throw new Error(`registration answered ${response.status}`);
  return { installId, installToken: response.body.install_token as string };
}

/** Bytes that pass the first-bytes check for AAC in MP4: a stand-in worker never decodes them. */
export function aacClipBytes(totalBytes = 4_096): Buffer {
  const header = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A ')]);
  return Buffer.concat([header, randomBytes(Math.max(0, totalBytes - header.length))]);
}

export interface RecognizeOptions {
  fields?: Record<string, string | undefined>;
  audio?: Buffer | null;
  fileName?: string;
  contentType?: string;
  installToken?: string | null;
  clientAddress?: string;
}

export function defaultRecognizeFields(now = new Date()): Record<string, string> {
  return {
    clip_duration_milliseconds: '8000',
    codec: 'aac',
    idempotency_key: randomUUID(),
    captured_at: new Date(now.getTime() - 9_000).toISOString(),
    sent_at: new Date(now.getTime() - 500).toISOString(),
    is_deferred: 'false',
  };
}

export function recognize(client: () => supertest.Agent, options: RecognizeOptions = {}) {
  const fields = { ...defaultRecognizeFields(), ...options.fields };
  let request = client().post('/api/v1/recognize');
  if (options.installToken !== null) request = request.set('Authorization', `Bearer ${options.installToken ?? ''}`);
  request = request.set('X-Forwarded-For', options.clientAddress ?? randomClientAddress());
  for (const [name, value] of Object.entries(fields)) if (value !== undefined) request = request.field(name, value);
  if (options.audio !== null) {
    request = request.attach('audio', options.audio ?? aacClipBytes(), { filename: options.fileName ?? 'clip.m4a', contentType: options.contentType ?? 'audio/mp4' });
  }
  return request;
}

/**
 * Sends a recognize request by hand, writing the body in chunks and stopping as soon as the server
 * answers: shows how much the server read before refusing, which a buffering client would hide.
 */
export function sendRecognizeInChunks(
  server: http.Server,
  options: { installToken: string; chunk: Buffer; chunkCount: number; declaredLength?: number },
): Promise<{ status: number; body: string; bytesWrittenBeforeAnswer: number }> {
  const { port } = server.address() as AddressInfo;
  const boundary = `----lookup-test-${randomUUID()}`;
  return new Promise((resolve, reject) => {
    let bytesWritten = 0;
    let answered = false;
    const request = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/api/v1/recognize',
      headers: {
        Authorization: `Bearer ${options.installToken}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'X-Forwarded-For': randomClientAddress(),
        ...(options.declaredLength !== undefined ? { 'Content-Length': String(options.declaredLength) } : { 'Transfer-Encoding': 'chunked' }),
      },
    });
    request.on('response', (response) => {
      answered = true;
      const bytesWrittenBeforeAnswer = bytesWritten;
      let body = '';
      response.on('data', (part: Buffer) => (body += part.toString('utf8')));
      response.on('end', () => {
        request.destroy();
        resolve({ status: response.statusCode ?? 0, body, bytesWrittenBeforeAnswer });
      });
    });
    request.on('error', (error) => {
      if (!answered) reject(error);
    });
    const preamble = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="clip.m4a"\r\nContent-Type: audio/mp4\r\n\r\n`);
    request.write(preamble);
    bytesWritten += preamble.length;
    let written = 0;
    const writeNext = () => {
      if (answered || written >= options.chunkCount) {
        if (!answered) request.end();
        return;
      }
      written += 1;
      bytesWritten += options.chunk.length;
      if (request.write(options.chunk)) setImmediate(writeNext);
      else request.once('drain', writeNext);
    };
    writeNext();
  });
}

/**
 * Starts a recognize request and stops sending part-way through the clip, as a phone losing its signal
 * would (or a sender holding connections open). Resolves with the server's answer and when it came.
 */
export function sendRecognizeAndStall(
  server: http.Server,
  options: { installToken: string },
): Promise<{ status: number; body: string; answeredAfterMilliseconds: number }> {
  const { port } = server.address() as AddressInfo;
  const boundary = `----lookup-test-${randomUUID()}`;
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/api/v1/recognize',
      headers: {
        Authorization: `Bearer ${options.installToken}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Transfer-Encoding': 'chunked',
        'X-Forwarded-For': randomClientAddress(),
      },
    });
    request.on('response', (response) => {
      let body = '';
      response.on('data', (part: Buffer) => (body += part.toString('utf8')));
      response.on('end', () => {
        request.destroy();
        resolve({ status: response.statusCode ?? 0, body, answeredAfterMilliseconds: Date.now() - startedAt });
      });
    });
    request.on('error', reject);
    request.write(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="clip.m4a"\r\nContent-Type: audio/mp4\r\n\r\n`);
    // A first part of the clip, then nothing more.
    request.write(aacClipBytes(4096));
  });
}

// ---- a stand-in recognize worker ----------------------------------------------------------------

export type FakeWorkerAnswer = RecognizeJobResult | { fail: string } | { hang: true } | { delayMilliseconds: number; answer: RecognizeJobResult };

/**
 * Takes `recognize` jobs like the Python worker does, answering whatever the test says, and keeps the
 * worker heartbeat present while it runs. The real worker is tested in fingerprint-workers.test.ts.
 */
export class FakeRecognizeWorker {
  readonly receivedJobs: Array<{ id: string; data: RecognizeJobData; options: Record<string, unknown> }> = [];
  answer: (data: RecognizeJobData) => FakeWorkerAnswer = () => noMatch();
  private readonly hungJobs: Array<() => void> = [];
  private readonly connection: Redis;
  private readonly heartbeatConnection: Redis;
  private readonly worker: Worker;
  private readonly heartbeatKey: string;
  private heartbeat: NodeJS.Timeout | undefined;

  constructor(keyValueStoreUrl: string, readonly queueKeyPrefix: string) {
    this.connection = new Redis(keyValueStoreUrl, { maxRetriesPerRequest: null });
    this.heartbeatConnection = new Redis(keyValueStoreUrl);
    this.heartbeatKey = workerHeartbeatKey(queueKeyPrefix, RECOGNIZE_QUEUE_NAME);
    this.worker = new Worker(
      RECOGNIZE_QUEUE_NAME,
      async (job) => {
        this.receivedJobs.push({ id: String(job.id), data: job.data as RecognizeJobData, options: job.opts as Record<string, unknown> });
        const answer = this.answer(job.data as RecognizeJobData);
        if ('hang' in answer) return new Promise<RecognizeJobResult>((resolve) => this.hungJobs.push(() => resolve(noMatch())));
        if ('fail' in answer) throw new Error(answer.fail);
        if ('delayMilliseconds' in answer) {
          await new Promise((resolve) => setTimeout(resolve, answer.delayMilliseconds));
          return answer.answer;
        }
        return answer;
      },
      { connection: this.connection, prefix: queueKeyPrefix, concurrency: 4 },
    );
    this.worker.on('error', () => undefined);
  }

  async startHeartbeat(): Promise<void> {
    const beat = () => this.heartbeatConnection.set(this.heartbeatKey, String(Date.now()), 'PX', 15_000);
    await beat();
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => void beat(), 2_000);
  }

  async stopHeartbeat(): Promise<void> {
    clearInterval(this.heartbeat);
    await this.heartbeatConnection.del(this.heartbeatKey);
  }

  /** Lets every job held by a { hang: true } answer finish, so it stops taking up the worker. */
  releaseHungJobs(): void {
    for (const release of this.hungJobs.splice(0)) release();
  }

  /** Stops taking jobs. Waits for jobs in hand, and so also cuts off a fetch already waiting for the next one. */
  pause(): Promise<void> {
    return this.worker.pause(false);
  }

  resume(): void {
    this.worker.resume();
  }

  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    await this.worker.close(true);
    await Promise.allSettled([this.connection.quit(), this.heartbeatConnection.quit()]);
  }
}

export function match(audioAssetNumber: number, changes: Partial<RecognizeJobResult> = {}): RecognizeJobResult {
  return { status: 'MATCH', audio_asset_number: audioAssetNumber, aligned_hash_count: 48, match_margin: 4.5, match_offset_milliseconds: 6016, ...changes };
}

export function noMatch(): RecognizeJobResult {
  return { status: 'NO_MATCH', audio_asset_number: null, aligned_hash_count: 3, match_margin: null, match_offset_milliseconds: null };
}

/** Jobs left in the recognize queue (waiting, active, delayed, completed, failed). */
export async function recognizeJobCount(keyValueStoreUrl: string, queueKeyPrefix: string): Promise<number> {
  const queue = new Queue(RECOGNIZE_QUEUE_NAME, { connection: new Redis(keyValueStoreUrl, { maxRetriesPerRequest: null }), prefix: queueKeyPrefix });
  try {
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed', 'prioritized');
    return Object.values(counts).reduce((total, count) => total + count, 0);
  } finally {
    await queue.close();
  }
}

// ---- stations that air an ad --------------------------------------------------------------------

export const CALL_CARD = {
  schema_version: 1,
  layout: 'VERTICAL_STACK',
  actions: [
    { type: 'CALL', id: '0192a6c4-0000-4000-8000-0000000000c1', label: 'Call us', style: 'PRIMARY', phone_number_e164: '+260977123456' },
    { type: 'WHATSAPP', id: '0192a6c4-0000-4000-8000-0000000000c2', label: 'Chat with us', style: 'SECONDARY', phone_number_e164: '+260966123456', prefilled_text: 'Hi, I heard your ad' },
    { type: 'MAP', id: '0192a6c4-0000-4000-8000-0000000000c3', label: 'Find us', style: 'OUTLINE', latitude: -15.4167, longitude: 28.2833 },
  ],
};

/**
 * A card for new tests (P4 design §6.1): numbers from Ofcom's drama range (+44 7700 900NNN, never given to a
 * phone company) and links on example.com, each action with its own id. `firstNumber` picks NNN for the call
 * button; the WhatsApp button takes the next number. CALL_CARD above keeps its numbers until the sweep (Q7).
 */
export function safeActionCard(options: { firstNumber?: number; callLabel?: string } = {}) {
  const number = (offset: number) => `+447700900${String((((options.firstNumber ?? 1) + offset - 1) % 999) + 1).padStart(3, '0')}`;
  return {
    schema_version: 1,
    layout: 'VERTICAL_STACK',
    actions: [
      { type: 'CALL', id: randomUUID(), label: options.callLabel ?? 'Call us', style: 'PRIMARY', phone_number_e164: number(0) },
      { type: 'WHATSAPP', id: randomUUID(), label: 'Chat with us', style: 'SECONDARY', phone_number_e164: number(1), prefilled_text: 'Hi, I heard your ad' },
      { type: 'LINK', id: randomUUID(), label: 'See the offer', style: 'OUTLINE', url: 'https://example.com/offer' },
    ],
  };
}

export interface AiringAd {
  stationId: string;
  clientId: string;
  adId: string;
  campaignId: string;
  actionCardId: string;
  audioAssetId: string;
  audioAssetNumber: number;
}

/** Creates stations, ads and campaigns straight in the database (as the setup user) and removes them afterwards. */
export class AiringAds {
  private readonly stationIds: string[] = [];
  private readonly assetIds: string[] = [];

  constructor(private readonly setupClient: pg.Client) {}

  async newAudioAsset(): Promise<{ audioAssetId: string; audioAssetNumber: number }> {
    const audioAssetId = randomUUID();
    this.assetIds.push(audioAssetId);
    const row = await this.setupClient.query(
      `INSERT INTO fingerprints.audio_assets (id, content_sha256, duration_milliseconds, fingerprint_version, hash_count) VALUES ($1, $2, 30000, 1, 500) RETURNING asset_number`,
      [audioAssetId, randomBytes(32)],
    );
    return { audioAssetId, audioAssetNumber: row.rows[0].asset_number as number };
  }

  /**
   * A station airing an ad on `audio` (a new recording unless given): its campaign runs `period` and is on
   * air in the given windows, in the station's time zone (by default every day, all day).
   */
  async create(options: {
    audio?: { audioAssetId: string; audioAssetNumber: number };
    stationStatus?: string;
    timeZone?: string;
    period?: [string, string];
    windows?: Array<{ days: number[]; from: string; to: string }>;
    card?: object;
    defaultCard?: object;
    stationId?: string;
  } = {}): Promise<AiringAd> {
    const audio = options.audio ?? (await this.newAudioAsset());
    const stationId = options.stationId ?? randomUUID();
    if (!options.stationId) {
      this.stationIds.push(stationId);
      await this.setupClient.query(`INSERT INTO app.stations (id, name, frequency_label, status, time_zone) VALUES ($1, $2, '98.1 FM', $3, $4)`, [
        stationId, `Listener test ${stationId.slice(0, 8)}`, options.stationStatus ?? 'ACTIVE', options.timeZone ?? 'Africa/Lusaka',
      ]);
    }
    const clientId = randomUUID();
    await this.setupClient.query(`INSERT INTO app.clients (id, station_id, name) VALUES ($1, $2, 'Brand A')`, [clientId, stationId]);
    const actionCardId = randomUUID();
    await this.setupClient.query(`INSERT INTO app.action_cards (id, station_id, client_id, schema_version, content) VALUES ($1, $2, $3, 1, $4)`, [
      actionCardId, stationId, clientId, options.card ?? CALL_CARD,
    ]);
    if (options.defaultCard) {
      const defaultCardId = randomUUID();
      await this.setupClient.query(`INSERT INTO app.action_cards (id, station_id, client_id, schema_version, content) VALUES ($1, $2, $3, 1, $4)`, [
        defaultCardId, stationId, clientId, options.defaultCard,
      ]);
      await this.setupClient.query('UPDATE app.clients SET default_action_card_id = $2 WHERE id = $1', [clientId, defaultCardId]);
    }
    const adId = randomUUID();
    await this.setupClient.query(
      `INSERT INTO app.ads (id, station_id, client_id, title, status, audio_asset_id, current_action_card_id) VALUES ($1, $2, $3, 'Summer service offer', 'READY', $4, $5)`,
      [adId, stationId, clientId, audio.audioAssetId, actionCardId],
    );
    const [startsAt, endsAt] = options.period ?? [new Date(Date.now() - 7 * 86_400_000).toISOString(), new Date(Date.now() + 7 * 86_400_000).toISOString()];
    const campaignId = randomUUID();
    await this.setupClient.query(
      `INSERT INTO app.campaigns (id, station_id, ad_id, action_card_id, name, status, active_period) VALUES ($1, $2, $3, $4, 'Campaign', 'ACTIVE', tstzrange($5::timestamptz, $6::timestamptz))`,
      [campaignId, stationId, adId, actionCardId, startsAt, endsAt],
    );
    for (const window of options.windows ?? [{ days: [1, 2, 3, 4, 5, 6, 7], from: '00:00', to: '12:00' }, { days: [1, 2, 3, 4, 5, 6, 7], from: '12:00', to: '00:00' }]) {
      await this.setupClient.query(
        `INSERT INTO app.campaign_time_windows (campaign_id, station_id, days_of_week, local_start_time, local_end_time) VALUES ($1, $2, $3, $4, $5)`,
        [campaignId, stationId, window.days, window.from, window.to],
      );
    }
    return { stationId, clientId, adId, campaignId, actionCardId, ...audio };
  }

  async removeAll(installIds: string[] = []): Promise<void> {
    const query = (sql: string, values: unknown[]) => this.setupClient.query(sql, values);
    // What phase 4 stores about a recognition goes first: candidates refer to it, and taps, counters and
    // reports to the stations' campaigns.
    await query(
      `DELETE FROM app.engagement_deduplication_keys WHERE recognition_id IN (
         SELECT id FROM app.recognition_events WHERE listener_install_id = ANY($1) OR station_id = ANY($2))`,
      [installIds, this.stationIds],
    );
    await query('DELETE FROM app.engagement_events WHERE station_id = ANY($1)', [this.stationIds]);
    await query('DELETE FROM app.recognition_reports WHERE station_id = ANY($1)', [this.stationIds]);
    await query('DELETE FROM app.campaign_counters WHERE station_id = ANY($1)', [this.stationIds]);
    await query(
      `DELETE FROM app.recognition_candidates WHERE station_id = ANY($2) OR recognition_id IN (
         SELECT id FROM app.recognition_events WHERE listener_install_id = ANY($1))`,
      [installIds, this.stationIds],
    );
    await query('DELETE FROM app.recognition_idempotency_keys WHERE listener_install_id = ANY($1)', [installIds]);
    await query('DELETE FROM app.recognition_events WHERE listener_install_id = ANY($1) OR station_id = ANY($2) OR hinted_station_id = ANY($2)', [installIds, this.stationIds]);
    await query('DELETE FROM app.campaign_time_windows WHERE station_id = ANY($1)', [this.stationIds]);
    await query('DELETE FROM app.campaigns WHERE station_id = ANY($1)', [this.stationIds]);
    await query('DELETE FROM app.ads WHERE station_id = ANY($1)', [this.stationIds]);
    await query('UPDATE app.clients SET default_action_card_id = NULL WHERE station_id = ANY($1)', [this.stationIds]);
    await query('DELETE FROM app.action_cards WHERE station_id = ANY($1)', [this.stationIds]);
    await query('DELETE FROM app.clients WHERE station_id = ANY($1)', [this.stationIds]);
    await query('DELETE FROM app.audit_events WHERE station_id = ANY($1)', [this.stationIds]);
    await query('DELETE FROM app.stations WHERE id = ANY($1)', [this.stationIds]);
    await query('DELETE FROM fingerprints.audio_assets WHERE id = ANY($1)', [this.assetIds]);
  }
}

/** The ids of installs registered from raw install ids, to clean up their rows. */
export async function installRowIds(setupClient: pg.Client): Promise<string[]> {
  return (await setupClient.query(`SELECT id FROM app.listener_installs WHERE app_version = '1.0.0' AND created_at > now() - interval '1 hour'`)).rows.map(
    (row) => row.id as string,
  );
}
