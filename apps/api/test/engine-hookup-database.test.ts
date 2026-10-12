import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseSetupClient, fingerprintWorkerClient, lookupApiClient } from './support/database-clients.js';

/**
 * Step 3's database functions (docs/design/step-3-engine-hookup.md), called as the roles that use
 * them: the ingest worker's one way to change an ad, the API's ingest sweep, and claiming and finishing a
 * recognition. P4 created the claim and the finish again (P4 design §4.4): their Step 3 tests keep their names
 * here; what P4 added, and the functions that replaced finding the stations and describing a replay, are
 * tested in station-resolution-database.test.ts.
 */
describe('engine hookup: database functions', () => {
  let setupClient: pg.Client;
  let apiClient: pg.Client;
  let workerClient: pg.Client;
  const stationIds: string[] = [];
  const installIds: string[] = [];
  const assetIds: string[] = [];

  beforeAll(async () => {
    setupClient = databaseSetupClient();
    apiClient = lookupApiClient();
    workerClient = fingerprintWorkerClient();
    await Promise.all([setupClient.connect(), apiClient.connect(), workerClient.connect()]);
  });
  afterAll(async () => {
    await setupClient.query('DELETE FROM app.recognition_idempotency_keys WHERE listener_install_id = ANY($1)', [installIds]);
    await setupClient.query('DELETE FROM app.recognition_events WHERE listener_install_id = ANY($1)', [installIds]);
    await setupClient.query('DELETE FROM app.listener_installs WHERE id = ANY($1)', [installIds]);
    await setupClient.query('DELETE FROM app.campaign_time_windows WHERE station_id = ANY($1)', [stationIds]);
    await setupClient.query('DELETE FROM app.campaigns WHERE station_id = ANY($1)', [stationIds]);
    await setupClient.query('DELETE FROM app.ads WHERE station_id = ANY($1)', [stationIds]);
    await setupClient.query('UPDATE app.clients SET default_action_card_id = NULL WHERE station_id = ANY($1)', [stationIds]);
    await setupClient.query('DELETE FROM app.action_cards WHERE station_id = ANY($1)', [stationIds]);
    await setupClient.query('DELETE FROM app.clients WHERE station_id = ANY($1)', [stationIds]);
    await setupClient.query('DELETE FROM app.audit_events WHERE station_id = ANY($1)', [stationIds]);
    await setupClient.query('DELETE FROM app.stations WHERE id = ANY($1)', [stationIds]);
    await setupClient.query('DELETE FROM fingerprints.audio_assets WHERE id = ANY($1)', [assetIds]);
    await Promise.all([setupClient.end(), apiClient.end(), workerClient.end()]);
  });

  // ---- test data ------------------------------------------------------------------------------------
  async function createStation(options: { status?: string; timeZone?: string } = {}) {
    const stationId = randomUUID();
    stationIds.push(stationId);
    await setupClient.query(`INSERT INTO app.stations (id, name, frequency_label, status, time_zone) VALUES ($1, $2, '98.1 FM', $3, $4)`, [
      stationId, `Engine test ${stationId.slice(0, 8)}`, options.status ?? 'ACTIVE', options.timeZone ?? 'Africa/Lusaka',
    ]);
    const clientId = randomUUID();
    await setupClient.query(`INSERT INTO app.clients (id, station_id, name) VALUES ($1, $2, 'Brand A')`, [clientId, stationId]);
    return { stationId, clientId };
  }

  async function createAudioAsset() {
    const assetId = randomUUID();
    assetIds.push(assetId);
    const row = await setupClient.query(
      `INSERT INTO fingerprints.audio_assets (id, content_sha256, duration_milliseconds, fingerprint_version, hash_count)
       VALUES ($1, $2, 30000, 1, 100) RETURNING asset_number`,
      [assetId, randomBytes(32)],
    );
    return { assetId, assetNumber: row.rows[0].asset_number as number };
  }

  async function createAd(station: { stationId: string; clientId: string }, options: { status?: string; audioAssetId?: string; archived?: boolean; uploadedMinutesAgo?: number } = {}) {
    const adId = randomUUID();
    await setupClient.query(
      `INSERT INTO app.ads (id, station_id, client_id, title, status, audio_asset_id, upload_object_key, uploaded_at, archived_at)
       VALUES ($1, $2, $3, 'Summer offer', $4, $5, $6, now() - make_interval(mins => $7), CASE WHEN $8 THEN now() END)`,
      [adId, station.stationId, station.clientId, options.status ?? 'PROCESSING', options.audioAssetId ?? null,
        `ad-uploads/${station.stationId}/${adId}/audio`, options.uploadedMinutesAgo ?? 0, options.archived ?? false],
    );
    return adId;
  }

  async function createInstall() {
    const installId = randomUUID();
    installIds.push(installId);
    await setupClient.query(`INSERT INTO app.listener_installs (id, install_id_hash, platform, app_version) VALUES ($1, $2, 'ANDROID', '1.0.0')`, [
      installId, randomBytes(32),
    ]);
    return installId;
  }

  async function adRow(adId: string) {
    return (await setupClient.query('SELECT status, audio_asset_id, duration_milliseconds, processing_error_code, upload_content_sha256 FROM app.ads WHERE id = $1', [adId])).rows[0];
  }

  // ---- the ingest worker's one function -------------------------------------------------------------
  describe('fingerprints.record_ad_ingest_result', () => {
    const record = (adId: string, assetId: string | null, sha256: Buffer, reason: string | null, client = workerClient) =>
      client.query('SELECT fingerprints.record_ad_ingest_result($1, $2, $3, $4, $5) AS changed', [adId, assetId, sha256, reason, 'request-ingest-test']);

    it('makes a waiting ad READY with its asset, duration and SHA-256, and records it in the audit trail', async () => {
      const station = await createStation();
      const asset = await createAudioAsset();
      const adId = await createAd(station);
      const sha256 = randomBytes(32);
      expect((await record(adId, asset.assetId, sha256, null)).rows[0].changed).toBe(true);
      expect(await adRow(adId)).toEqual({ status: 'READY', audio_asset_id: asset.assetId, duration_milliseconds: 30000, processing_error_code: null, upload_content_sha256: sha256 });
      const audit = await setupClient.query(`SELECT action, actor_portal_user_id, request_id, changes FROM app.audit_events WHERE entity_id = $1`, [adId]);
      expect(audit.rows).toEqual([{ action: 'ad_audio_ready', actor_portal_user_id: null, request_id: 'request-ingest-test', changes: { durationMilliseconds: 30000 } }]);
    });

    it('marks a refused file FAILED with its reason, and accepts only the reasons it knows', async () => {
      const station = await createStation();
      const adId = await createAd(station);
      expect((await record(adId, null, randomBytes(32), 'audio_too_short')).rows[0].changed).toBe(true);
      expect(await adRow(adId)).toMatchObject({ status: 'FAILED', processing_error_code: 'audio_too_short', audio_asset_id: null });
      const audit = await setupClient.query(`SELECT action, changes FROM app.audit_events WHERE entity_id = $1`, [adId]);
      expect(audit.rows).toEqual([{ action: 'ad_upload_refused', changes: { reason: 'audio_too_short' } }]);

      const otherAdId = await createAd(station);
      await expect(record(otherAdId, null, randomBytes(32), 'DecodeError: moov atom not found')).rejects.toThrow(/unknown refusal reason/);
      await expect(record(otherAdId, null, randomBytes(32), null)).rejects.toThrow(/exactly one/);
      expect((await adRow(otherAdId)).status).toBe('PROCESSING');
    });

    it('leaves alone an ad that is no longer waiting: already ready, archived, or given a new file', async () => {
      const station = await createStation();
      const asset = await createAudioAsset();
      for (const options of [{ status: 'READY' }, { archived: true }, { status: 'AWAITING_UPLOAD' }]) {
        const adId = await createAd(station, options);
        expect((await record(adId, asset.assetId, randomBytes(32), null)).rows[0].changed).toBe(false);
      }
    });

    it('is the worker role’s only way to change an ad, and only the worker may call it', async () => {
      const station = await createStation();
      const adId = await createAd(station);
      await expect(workerClient.query('SELECT 1 FROM app.ads LIMIT 1')).rejects.toThrow(/permission denied/);
      await expect(workerClient.query(`UPDATE app.ads SET status = 'READY' WHERE id = $1`, [adId])).rejects.toThrow(/permission denied/);
      await expect(record(adId, null, randomBytes(32), 'audio_too_long', apiClient)).rejects.toThrow(/permission denied/);
    });

    it('the API role cannot write the uploaded audio’s checksum, which only the worker records', async () => {
      const privilege = await setupClient.query(`SELECT has_column_privilege('lookup_api', 'app.ads', 'upload_content_sha256', 'UPDATE') AS can_update`);
      expect(privilege.rows[0].can_update).toBe(false);
      await expect(apiClient.query('UPDATE app.ads SET upload_content_sha256 = $1', [randomBytes(32)])).rejects.toThrow(/permission denied/);
    });
  });

  // ---- the API's ingest sweep -----------------------------------------------------------------------
  it('each Step 3 function returns only what its caller needs, and only that caller may run it', async () => {
    const functions = (await setupClient.query(
      `SELECT n.nspname || '.' || p.proname AS name, pg_get_function_result(p.oid) AS result,
              array_remove(ARRAY[CASE WHEN has_function_privilege('lookup_api', p.oid, 'EXECUTE') THEN 'lookup_api' END,
                                 CASE WHEN has_function_privilege('lookup_admin_api', p.oid, 'EXECUTE') THEN 'lookup_admin_api' END,
                                 CASE WHEN has_function_privilege('lookup_fingerprint_worker', p.oid, 'EXECUTE') THEN 'lookup_fingerprint_worker' END], NULL) AS callers
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.proname = ANY($1) ORDER BY 1`,
      [['record_ad_ingest_result', 'find_ads_waiting_for_ingest', 'claim_recognition', 'finish_recognition', 'find_stations_for_audio', 'describe_recognition']],
    )).rows as Array<{ name: string; result: string; callers: string[] }>;
    // P4 created the claim and the finish again, and replaced finding the stations and describing a replay
    // (station-resolution-database.test.ts checks the new functions).
    expect(Object.fromEntries(functions.map((found) => [found.name, { result: found.result, callers: found.callers }]))).toEqual({
      'app.find_ads_waiting_for_ingest': { result: 'TABLE(ad_id uuid, upload_object_key text)', callers: ['lookup_api'] },
      'fingerprints.record_ad_ingest_result': { result: 'boolean', callers: ['lookup_fingerprint_worker'] },
      'recognition.claim_recognition': {
        result: 'TABLE(recognition_id uuid, recognition_received_at timestamp with time zone, recognition_captured_at timestamp with time zone, attempt_number integer, claim_outcome text, previous_outcome text, is_deferred boolean)',
        callers: ['lookup_api'],
      },
      'recognition.finish_recognition': { result: 'boolean', callers: ['lookup_api'] },
    });
  });

  describe('app.find_ads_waiting_for_ingest', () => {
    it('finds ads at every station that have waited too long, oldest first, and nothing else', async () => {
      const stationA = await createStation();
      const stationB = await createStation();
      const longWaitingA = await createAd(stationA, { uploadedMinutesAgo: 60 * 24 * 365 * 5 });
      const longWaitingB = await createAd(stationB, { uploadedMinutesAgo: 60 * 24 * 365 * 4 });
      const justArrived = await createAd(stationA, { uploadedMinutesAgo: 1 });
      const ready = await createAd(stationA, { status: 'READY', uploadedMinutesAgo: 60 * 24 * 365 * 5 });
      const archived = await createAd(stationB, { archived: true, uploadedMinutesAgo: 60 * 24 * 365 * 5 });

      const found = (await apiClient.query(`SELECT * FROM app.find_ads_waiting_for_ingest(interval '5 minutes', 500)`)).rows as Array<{ ad_id: string; upload_object_key: string }>;
      const foundIds = found.map((row) => row.ad_id);
      expect(foundIds).toEqual(expect.arrayContaining([longWaitingA, longWaitingB]));
      expect(foundIds.indexOf(longWaitingA)).toBeLessThan(foundIds.indexOf(longWaitingB));
      for (const notWaiting of [justArrived, ready, archived]) expect(foundIds).not.toContain(notWaiting);
      expect(Object.keys(found[0] as object).sort()).toEqual(['ad_id', 'upload_object_key']);
      await expect(workerClient.query(`SELECT * FROM app.find_ads_waiting_for_ingest(interval '5 minutes', 10)`)).rejects.toThrow(/permission denied/);
    });
  });

  // ---- recognition ----------------------------------------------------------------------------------
  describe('recognition.claim_recognition and finish_recognition', () => {
    const claim = (installId: string, key: string, receivedAt = new Date()) =>
      apiClient.query('SELECT * FROM recognition.claim_recognition($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', [
        installId, key, randomUUID(), `request-${randomUUID()}`, receivedAt, receivedAt, 0, receivedAt, false, 8000,
      ]).then((result) => result.rows[0] as Claimed);
    type Claimed = { recognition_id: string; recognition_received_at: Date; attempt_number: number; claim_outcome: string; previous_outcome: string | null };
    // An outcome with no station shown: no resolution, no hint and no stations weighed.
    const finish = (claimed: Claimed, outcome: string) =>
      apiClient.query("SELECT recognition.finish_recognition($1, $2, $3, $4, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '[]'::jsonb, 0, NULL, NULL, 120, 1::smallint) AS changed", [
        claimed.recognition_id, claimed.recognition_received_at, claimed.attempt_number, outcome,
      ]).then((result) => result.rows[0].changed as boolean);
    const eventRow = (recognitionId: string) =>
      setupClient.query('SELECT outcome, attempt_count, completed_at, received_at FROM app.recognition_events WHERE id = $1', [recognitionId]).then((result) => result.rows[0]);

    it('a new key makes one PENDING recognition; finishing it sets the outcome and when it completed', async () => {
      const installId = await createInstall();
      const claimed = await claim(installId, randomUUID());
      expect(claimed.claim_outcome).toBe('CLAIMED');
      expect(await eventRow(claimed.recognition_id)).toMatchObject({ outcome: 'PENDING', attempt_count: 1, completed_at: null });

      expect(await finish(claimed, 'NO_MATCH')).toBe(true);
      const finished = await eventRow(claimed.recognition_id);
      expect(finished.outcome).toBe('NO_MATCH');
      expect(finished.completed_at).toBeInstanceOf(Date);
      // A late second finish cannot overwrite it.
      expect(await finish(claimed, 'AMBIGUOUS')).toBe(false);
      expect((await eventRow(claimed.recognition_id)).outcome).toBe('NO_MATCH');
    });

    it('the same key again: in progress while fresh, finished once done, and claimed again after a timeout, keeping its first receipt time', async () => {
      const installId = await createInstall();
      const key = randomUUID();
      const first = await claim(installId, key);
      expect((await claim(installId, key)).claim_outcome).toBe('IN_PROGRESS');

      expect(first.attempt_number).toBe(1);
      await finish(first, 'TIMEOUT');
      const retried = await claim(installId, key, new Date(Date.now() + 5_000));
      expect(retried).toMatchObject({ recognition_id: first.recognition_id, attempt_number: 2, claim_outcome: 'RECLAIMED', previous_outcome: 'TIMEOUT' });
      expect(retried.recognition_received_at).toEqual(first.recognition_received_at);
      expect(await eventRow(first.recognition_id)).toMatchObject({ outcome: 'PENDING', attempt_count: 2 });

      // The first attempt answers late: it is no longer that attempt's to record.
      expect(await finish(first, 'NO_MATCH')).toBe(false);
      expect(await finish(retried, 'AMBIGUOUS')).toBe(true);
      expect(await claim(installId, key)).toMatchObject({ recognition_id: first.recognition_id, claim_outcome: 'FINISHED', previous_outcome: 'AMBIGUOUS' });
    });

    it('keys belong to their install: another install with the same key gets its own recognition', async () => {
      const key = randomUUID();
      const first = await claim(await createInstall(), key);
      const second = await claim(await createInstall(), key);
      expect(second.claim_outcome).toBe('CLAIMED');
      expect(second.recognition_id).not.toBe(first.recognition_id);
    });

    it('a PENDING claim older than 30 seconds is claimed again (its attempt was abandoned)', async () => {
      const installId = await createInstall();
      const key = randomUUID();
      const first = await claim(installId, key);
      await setupClient.query(`UPDATE app.recognition_events SET last_claimed_at = now() - interval '31 seconds' WHERE id = $1`, [first.recognition_id]);
      expect(await claim(installId, key)).toMatchObject({ claim_outcome: 'RECLAIMED', previous_outcome: 'PENDING' });
    });

    it('the API role reaches the keys and events only through these functions, and the worker not at all', async () => {
      await expect(apiClient.query('SELECT * FROM app.recognition_idempotency_keys LIMIT 1')).rejects.toThrow(/permission denied/);
      await expect(apiClient.query(`DELETE FROM app.recognition_idempotency_keys`)).rejects.toThrow(/permission denied/);
      await expect(apiClient.query(`UPDATE app.recognition_events SET outcome = 'MATCH'`)).rejects.toThrow(/permission denied/);
      await expect(workerClient.query(`SELECT * FROM recognition.claim_recognition(NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`)).rejects.toThrow(/permission denied/);
      await expect(workerClient.query(`SELECT * FROM recognition.find_station_candidates(1, now())`)).rejects.toThrow(/permission denied/);
    });

    it('refuses an outcome it does not know', async () => {
      const claimed = await claim(await createInstall(), randomUUID());
      await expect(finish(claimed, 'MATCH_FOUND')).rejects.toThrow(/unknown outcome/);
    });
  });

  it('a station’s name and frequency keep to what a listener’s answer can carry', async () => {
    await expect(setupClient.query(`INSERT INTO app.stations (id, name, frequency_label) VALUES ($1, $2, '98.1 FM')`, [randomUUID(), 'x'.repeat(121)])).rejects.toThrow(/stations_name_check/);
    await expect(setupClient.query(`INSERT INTO app.stations (id, name, frequency_label) VALUES ($1, 'Station', $2)`, [randomUUID(), '9'.repeat(33)])).rejects.toThrow(/stations_frequency_label_check/);
  });

});
