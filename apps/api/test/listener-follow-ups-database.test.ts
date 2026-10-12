import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseSetupClient, lookupApiClient } from './support/database-clients.js';
import { type Claimed, recognitionIdAt, StationResolutionTestData, type StationAiring } from './support/station-resolution-test-data.js';

const { candidate } = StationResolutionTestData;

/**
 * What a listener sends after an answer (P4 design §4.4, §5.5, §5.8, §5.9), as the API role calls it: the
 * station chosen on a chooser, the "My station" list, a button tap and its tap limits, "Report this", and the
 * clean-up of old idempotency keys. Each function answers with a code the API turns into its HTTP answer.
 */
describe('listener follow-ups: database functions', () => {
  let setupClient: pg.Client;
  let apiClient: pg.Client;
  let testData: StationResolutionTestData;

  beforeAll(async () => {
    setupClient = databaseSetupClient();
    apiClient = lookupApiClient();
    await Promise.all([setupClient.connect(), apiClient.connect()]);
    testData = new StationResolutionTestData(setupClient);
  });
  afterAll(async () => {
    await testData.removeAll();
    await Promise.all([setupClient.end(), apiClient.end()]);
  });

  const shownCampaignCard = (airing: StationAiring) => ({ stationId: airing.stationId, campaignId: airing.campaignId, cardId: airing.campaignCardId as string });
  const shownDefaultCard = (airing: StationAiring) => ({ stationId: airing.stationId, campaignId: airing.campaignId, cardId: airing.defaultCardId as string });
  const actionId = (card: StationAiring['campaignCard'], index = 0) => (card?.actions[index] as { id: string }).id;
  const eventRow = async (recognitionId: string) =>
    (await setupClient.query('SELECT * FROM app.recognition_events WHERE id = $1', [recognitionId])).rows[0] as Record<string, unknown>;
  const counterOf = async (airing: StationAiring) =>
    ((await setupClient.query('SELECT counted_engagement_count FROM app.campaign_counters WHERE campaign_id = $1', [airing.campaignId])).rows[0]
      ?.counted_engagement_count ?? null) as number | null;
  const chosenStations = async (recognitionId: string) =>
    (await setupClient.query('SELECT station_id FROM app.recognition_candidates WHERE recognition_id = $1 AND is_chosen', [recognitionId])).rows.map(
      (row) => row.station_id as string,
    );

  /** A recognition answered with a chooser of stations A and B (A first), each on air with its campaign card and with a client's default card. */
  async function answeredChooser(options: { engagementLimit?: number | null } = {}) {
    const recording = await testData.createRecording();
    const stationA = await testData.airAd({ recording, hasDefaultCard: true, engagementLimit: options.engagementLimit ?? null });
    const stationB = await testData.airAd({ recording, hasDefaultCard: true, engagementLimit: options.engagementLimit ?? null });
    const offAir = await testData.airAd({ recording, hasDefaultCard: true, windows: [{ days: [1], from: '03:00', to: '03:15' }] });
    const installId = await testData.createInstall();
    const claimed = await testData.claim(apiClient, installId);
    await testData.finish(apiClient, claimed, {
      outcome: 'CHOOSE_STATION',
      resolution: 'UNRESOLVED',
      recording,
      candidates: [candidate(stationA, { displayPosition: 1 }), candidate(stationB, { displayPosition: 2 }), candidate(offAir, { kind: 'CLIENT_DEFAULT', isInWindow: false })],
    });
    return { recording, stationA, stationB, offAir, installId, claimed };
  }

  /** A recognition answered with one station's campaign card (or, with `isDefaultCard`, its client's default card). */
  async function answeredMatch(options: { engagementLimit?: number | null; isDefaultCard?: boolean; installId?: string; airing?: StationAiring; recording?: Awaited<ReturnType<StationResolutionTestData['createRecording']>> } = {}) {
    const recording = options.recording ?? (await testData.createRecording());
    const airing = options.airing ?? (await testData.airAd({ recording, hasDefaultCard: true, engagementLimit: options.engagementLimit ?? null }));
    const installId = options.installId ?? (await testData.createInstall());
    const claimed = await testData.claim(apiClient, installId);
    await testData.finish(apiClient, claimed, options.isDefaultCard
      ? { outcome: 'MATCH_DEFAULT', resolution: 'SINGLE_OWNER', recording, shown: shownDefaultCard(airing), candidates: [candidate(airing, { kind: 'CLIENT_DEFAULT', isInWindow: false })] }
      : { outcome: 'MATCH', resolution: 'SINGLE_OWNER', recording, shown: shownCampaignCard(airing), candidates: [candidate(airing)] });
    return { recording, airing, installId, claimed };
  }

  // ---- recognition.record_station_choice -------------------------------------------------------------------
  describe('recognition.record_station_choice', () => {
    const choose = async (recognitionId: string, installId: string, stationId: string) =>
      (await apiClient.query('SELECT recognition.record_station_choice($1, $2, $3) AS answer', [recognitionId, installId, stationId])).rows[0].answer as string;

    it('P4-CHOICE-01 to -05: a shown station is chosen once: CHOSEN, then ALREADY_CHOSEN, and the recognition takes the listener choice with that station, campaign and card; no counter moves', async () => {
      const { stationA, stationB, installId, claimed } = await answeredChooser();
      expect(await choose(claimed.recognition_id, installId, stationB.stationId)).toBe('CHOSEN');
      expect(await eventRow(claimed.recognition_id)).toMatchObject({
        outcome: 'CHOOSE_STATION',
        resolution: 'LISTENER_CHOICE',
        station_id: stationB.stationId,
        campaign_id: stationB.campaignId,
        action_card_id: stationB.campaignCardId,
      });
      const chosen = await setupClient.query('SELECT station_id, chosen_at FROM app.recognition_candidates WHERE recognition_id = $1 AND is_chosen', [claimed.recognition_id]);
      expect(chosen.rows).toEqual([{ station_id: stationB.stationId, chosen_at: expect.any(Date) }]);

      expect(await choose(claimed.recognition_id, installId, stationB.stationId)).toBe('ALREADY_CHOSEN');
      expect(await chosenStations(claimed.recognition_id)).toEqual([stationB.stationId]);
      expect(await counterOf(stationA)).toBeNull();
      expect(await counterOf(stationB)).toBeNull();
    });

    it('answers NOT_FOUND, NOT_A_CANDIDATE and ANOTHER_STATION_CHOSEN, and changes nothing', async () => {
      const { stationA, stationB, offAir, installId, claimed } = await answeredChooser();
      const match = await answeredMatch({ installId });
      const anotherInstall = await testData.createInstall();
      const before = await eventRow(claimed.recognition_id);
      expect(await choose(recognitionIdAt(Date.now()), installId, stationA.stationId)).toBe('NOT_FOUND');
      expect(await choose(claimed.recognition_id, anotherInstall, stationA.stationId)).toBe('NOT_FOUND');
      expect(await choose(match.claimed.recognition_id, installId, match.airing.stationId)).toBe('NOT_FOUND');
      // Weighed but not shown (out of window), and never weighed at all.
      expect(await choose(claimed.recognition_id, installId, offAir.stationId)).toBe('NOT_A_CANDIDATE');
      expect(await choose(claimed.recognition_id, installId, randomUUID())).toBe('NOT_A_CANDIDATE');
      expect(await eventRow(claimed.recognition_id)).toEqual(before);
      expect(await chosenStations(claimed.recognition_id)).toEqual([]);

      expect(await choose(claimed.recognition_id, installId, stationA.stationId)).toBe('CHOSEN');
      expect(await choose(claimed.recognition_id, installId, stationB.stationId)).toBe('ANOTHER_STATION_CHOSEN');
      expect(await chosenStations(claimed.recognition_id)).toEqual([stationA.stationId]);
      expect((await eventRow(claimed.recognition_id)).station_id).toBe(stationA.stationId);
    });
  });

  // ---- recognition.list_stations_for_listeners ------------------------------------------------------------
  describe('recognition.list_stations_for_listeners', () => {
    const listStations = async (maximumCount: number) =>
      (await apiClient.query('SELECT * FROM recognition.list_stations_for_listeners($1)', [maximumCount])).rows as Array<Record<string, unknown>>;

    it('lists only ACTIVE stations listed in the app, by lower-case name in byte order, then frequency, then id, each with its city', async () => {
      const tag = randomBytes(4).toString('hex');
      const station = (name: string, options: Parameters<StationResolutionTestData['createStation']>[0] = {}) =>
        testData.createStation({ name: `p4 list ${tag} ${name}`, ...options });
      const zulu = await station('zulu', { frequencyLabel: '90.0 FM' });
      const alphaLater = await station('Alpha', { frequencyLabel: '98.1 FM', city: 'Kitwe' });
      const alphaFirst = await station('alpha', { frequencyLabel: '104.3 FM', city: null });
      const upperBeta = await station('Beta', { frequencyLabel: '90.0 FM' });
      const hidden = [
        await station('unlisted', { isListedInApp: false }),
        await station('suspended', { status: 'SUSPENDED' }),
        await station('pending', { status: 'PENDING_REVIEW' }),
        await station('rejected', { status: 'REJECTED' }),
      ];
      const mine = new Set([zulu, alphaLater, alphaFirst, upperBeta, ...hidden]);
      const listed = (await listStations(1000)).filter((row) => mine.has(row.station_id as string));
      expect(listed.map((row) => row.station_id)).toEqual([alphaFirst, alphaLater, upperBeta, zulu]);
      expect(listed[0]).toEqual({ station_id: alphaFirst, station_name: `p4 list ${tag} alpha`, station_frequency_label: '104.3 FM', station_city: null });
      expect(listed[1]?.station_city).toBe('Kitwe');
    });

    it('returns at most the number asked for, and never more than 1,000', async () => {
      expect(await listStations(0)).toEqual([]);
      expect(await listStations(-5)).toEqual([]);
      await testData.createStation();
      expect(await listStations(1)).toHaveLength(1);
      await setupClient.query('BEGIN');
      try {
        await setupClient.query(
          `INSERT INTO app.stations (name, frequency_label, status) SELECT 'p4 many ' || number, '90.0 FM', 'ACTIVE' FROM generate_series(1, 1001) AS number`,
        );
        const listed = await setupClient.query('SELECT count(*)::integer AS listed FROM recognition.list_stations_for_listeners(5000)');
        expect(listed.rows[0].listed).toBe(1000);
      } finally {
        await setupClient.query('ROLLBACK');
      }
    });
  });

  // ---- recognition.record_engagement -----------------------------------------------------------------------
  describe('recognition.record_engagement', () => {
    interface Tap {
      recognition: Pick<Claimed, 'recognition_id'>;
      installId: string;
      stationId: string;
      actionId: string;
      correctedOccurredAt?: Date;
      receivedAt?: Date;
      maximumCountedTapsPerInstall?: number | null;
      engagementId?: string;
    }
    const tap = async (tapped: Tap) => {
      const receivedAt = tapped.receivedAt ?? new Date();
      const engagementId = tapped.engagementId ?? recognitionIdAt(receivedAt.getTime());
      const answer = (
        await apiClient.query('SELECT recognition.record_engagement($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) AS answer', [
          engagementId,
          tapped.recognition.recognition_id,
          tapped.installId,
          tapped.stationId,
          tapped.actionId,
          tapped.correctedOccurredAt ?? new Date(receivedAt.getTime() - 2_000),
          new Date(receivedAt.getTime() - 3_600_000),
          3_598_000,
          receivedAt,
          `request-${randomUUID()}`,
          tapped.maximumCountedTapsPerInstall === undefined ? null : tapped.maximumCountedTapsPerInstall,
        ])
      ).rows[0].answer as string;
      return { answer, engagementId };
    };
    const engagementRows = async (recognitionId: string) =>
      (await setupClient.query('SELECT * FROM app.engagement_events WHERE recognition_id = $1 ORDER BY received_at', [recognitionId])).rows as Array<Record<string, unknown>>;

    it('P4-ENGAGEMENTS-02, -09, -10, P4-LIMITS-02: stores a tap on the card shown once, with the type from the card, and counts it once', async () => {
      const { airing, installId, claimed } = await answeredMatch({ engagementLimit: 10 });
      const whatsApp = actionId(airing.campaignCard, 1);
      const first = await tap({ recognition: claimed, installId, stationId: airing.stationId, actionId: whatsApp });
      expect(first.answer).toBe('RECORDED');
      for (let resend = 0; resend < 2; resend += 1) {
        expect((await tap({ recognition: claimed, installId, stationId: airing.stationId, actionId: whatsApp })).answer).toBe('ALREADY_RECORDED');
      }
      const rows = await engagementRows(claimed.recognition_id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: first.engagementId,
        recognition_received_at: claimed.recognition_received_at,
        station_id: airing.stationId,
        campaign_id: airing.campaignId,
        action_card_id: airing.campaignCardId,
        card_kind: 'CAMPAIGN',
        action_id: whatsApp,
        action_type: 'WHATSAPP',
        clock_skew_milliseconds: '3598000',
        is_counted: true,
      });
      expect(await counterOf(airing)).toBe(1);
    });

    it('P4-ENGAGEMENTS-06, -07: answers NOT_FOUND for an unknown id, another install, and a recognition still being worked on, and stores nothing', async () => {
      const { airing, installId, claimed } = await answeredMatch();
      const callButton = actionId(airing.campaignCard);
      expect((await tap({ recognition: { recognition_id: recognitionIdAt(Date.now()) }, installId, stationId: airing.stationId, actionId: callButton })).answer).toBe('NOT_FOUND');
      expect((await tap({ recognition: claimed, installId: await testData.createInstall(), stationId: airing.stationId, actionId: callButton })).answer).toBe('NOT_FOUND');
      const pending = await testData.claim(apiClient, installId);
      expect((await tap({ recognition: pending, installId, stationId: airing.stationId, actionId: callButton })).answer).toBe('NOT_FOUND');
      await testData.finish(apiClient, pending, { outcome: 'TIMEOUT' });
      expect((await tap({ recognition: pending, installId, stationId: airing.stationId, actionId: callButton })).answer).toBe('NOT_FOUND');
      expect(await engagementRows(claimed.recognition_id)).toEqual([]);
      expect(await engagementRows(pending.recognition_id)).toEqual([]);
      expect(await counterOf(airing)).toBeNull();
    });

    it('P4-ENGAGEMENTS-05: answers NOT_A_CANDIDATE for a station whose card was not shown, and for a recognition that showed none', async () => {
      const { stationA, offAir, installId, claimed } = await answeredChooser();
      const match = await answeredMatch({ installId });
      expect((await tap({ recognition: claimed, installId, stationId: offAir.stationId, actionId: actionId(offAir.defaultCard) })).answer).toBe('NOT_A_CANDIDATE');
      expect((await tap({ recognition: match.claimed, installId, stationId: stationA.stationId, actionId: actionId(stationA.campaignCard) })).answer).toBe('NOT_A_CANDIDATE');
      const noMatch = await testData.claim(apiClient, installId);
      await testData.finish(apiClient, noMatch, { outcome: 'NO_MATCH', fallbackReason: 'no_station_airs_it' });
      expect((await tap({ recognition: noMatch, installId, stationId: stationA.stationId, actionId: actionId(stationA.campaignCard) })).answer).toBe('NOT_A_CANDIDATE');
      expect(await engagementRows(claimed.recognition_id)).toEqual([]);
      expect(await chosenStations(claimed.recognition_id)).toEqual([]);
    });

    it('P4-ENGAGEMENTS-10: answers ACTION_NOT_ON_CARD for an action that is not on the card version shown, even one on a newer card of the station', async () => {
      const { airing, installId, claimed } = await answeredMatch();
      const newerCard = await testData.createCard(airing.stationId, airing.clientId);
      await setupClient.query('UPDATE app.campaigns SET action_card_id = $2 WHERE id = $1', [airing.campaignId, newerCard.cardId]);
      expect((await tap({ recognition: claimed, installId, stationId: airing.stationId, actionId: actionId(newerCard.content) })).answer).toBe('ACTION_NOT_ON_CARD');
      expect((await tap({ recognition: claimed, installId, stationId: airing.stationId, actionId: randomUUID() })).answer).toBe('ACTION_NOT_ON_CARD');
      expect(await engagementRows(claimed.recognition_id)).toEqual([]);
      expect((await tap({ recognition: claimed, installId, stationId: airing.stationId, actionId: actionId(airing.campaignCard, 2) })).answer).toBe('RECORDED');
      expect((await engagementRows(claimed.recognition_id))[0]).toMatchObject({ action_card_id: airing.campaignCardId, action_type: 'LINK' });
    });

    it('A4, P4-ENGAGEMENTS-13: a tap on a chooser nobody answered records that station as the choice; a tap or a choice for another station then gets ANOTHER_STATION_CHOSEN', async () => {
      const { stationA, stationB, installId, claimed } = await answeredChooser({ engagementLimit: 10 });
      expect((await tap({ recognition: claimed, installId, stationId: stationB.stationId, actionId: actionId(stationB.campaignCard) })).answer).toBe('RECORDED');
      expect(await chosenStations(claimed.recognition_id)).toEqual([stationB.stationId]);
      expect(await eventRow(claimed.recognition_id)).toMatchObject({ resolution: 'LISTENER_CHOICE', station_id: stationB.stationId, campaign_id: stationB.campaignId });

      expect((await tap({ recognition: claimed, installId, stationId: stationA.stationId, actionId: actionId(stationA.campaignCard) })).answer).toBe('ANOTHER_STATION_CHOSEN');
      const choice = await apiClient.query('SELECT recognition.record_station_choice($1, $2, $3) AS answer', [claimed.recognition_id, installId, stationA.stationId]);
      expect(choice.rows[0].answer).toBe('ANOTHER_STATION_CHOSEN');
      expect((await engagementRows(claimed.recognition_id)).map((row) => row.station_id)).toEqual([stationB.stationId]);
      expect(await counterOf(stationB)).toBe(1);
      expect(await counterOf(stationA)).toBeNull();
      // Another button of the chosen station is a tap like any other.
      expect((await tap({ recognition: claimed, installId, stationId: stationB.stationId, actionId: actionId(stationB.campaignCard, 1) })).answer).toBe('RECORDED');
    });

    it('a tap on the client default card is stored, and never counted', async () => {
      const { airing, installId, claimed } = await answeredMatch({ isDefaultCard: true, engagementLimit: 10 });
      expect((await tap({ recognition: claimed, installId, stationId: airing.stationId, actionId: actionId(airing.defaultCard) })).answer).toBe('RECORDED');
      expect(await engagementRows(claimed.recognition_id)).toEqual([expect.objectContaining({ card_kind: 'CLIENT_DEFAULT', action_card_id: airing.defaultCardId, is_counted: false })]);
      expect(await counterOf(airing)).toBeNull();
    });

    it('P4-LIMITS-05 (database half): taps count until the limit is reached; later ones are stored, not counted, and answered the same', async () => {
      const recording = await testData.createRecording();
      const airing = await testData.airAd({ recording, engagementLimit: 2 });
      const answers: string[] = [];
      for (let listener = 0; listener < 3; listener += 1) {
        const { installId, claimed } = await answeredMatch({ recording, airing });
        answers.push((await tap({ recognition: claimed, installId, stationId: airing.stationId, actionId: actionId(airing.campaignCard) })).answer);
      }
      expect(answers).toEqual(['RECORDED', 'RECORDED', 'RECORDED']);
      expect(await counterOf(airing)).toBe(2);
      const counted = await setupClient.query('SELECT is_counted FROM app.engagement_events WHERE campaign_id = $1 ORDER BY received_at, id', [airing.campaignId]);
      expect(counted.rows.map((row) => row.is_counted)).toEqual([true, true, false]);
    });

    it('P4-ENGAGEMENTS-14: one install counts at most the cap on one campaign in 24 hours; another install still counts, and so does the first a day later', async () => {
      const recording = await testData.createRecording();
      const airing = await testData.airAd({ recording, engagementLimit: 100 });
      const busyInstall = await testData.createInstall();
      const isCounted = async (installId: string, receivedAt = new Date()) => {
        const { claimed } = await answeredMatch({ recording, airing, installId });
        const { engagementId } = await tap({ recognition: claimed, installId, stationId: airing.stationId, actionId: actionId(airing.campaignCard), receivedAt, maximumCountedTapsPerInstall: 2 });
        return (await setupClient.query('SELECT is_counted FROM app.engagement_events WHERE id = $1', [engagementId])).rows[0].is_counted as boolean;
      };
      expect([await isCounted(busyInstall), await isCounted(busyInstall), await isCounted(busyInstall)]).toEqual([true, true, false]);
      expect(await isCounted(await testData.createInstall())).toBe(true);
      expect(await isCounted(busyInstall, new Date(Date.now() + 25 * 3_600_000))).toBe(true);
      expect(await counterOf(airing)).toBe(4);
    });

    it('refuses a per-install cap under 1: no cap is NULL', async () => {
      const { airing, installId, claimed } = await answeredMatch();
      await expect(tap({ recognition: claimed, installId, stationId: airing.stationId, actionId: actionId(airing.campaignCard), maximumCountedTapsPerInstall: 0 })).rejects.toThrow(/per-install cap/);
    });

    it('P4-ENGAGEMENTS-03, -04: the corrected time of a tap is kept between the receipt of its recognition and the arrival of the tap', async () => {
      const { airing, installId, claimed } = await answeredMatch();
      const receivedAt = new Date();
      await tap({ recognition: claimed, installId, stationId: airing.stationId, actionId: actionId(airing.campaignCard, 0), correctedOccurredAt: new Date(Date.now() - 86_400_000), receivedAt });
      await tap({ recognition: claimed, installId, stationId: airing.stationId, actionId: actionId(airing.campaignCard, 1), correctedOccurredAt: new Date(Date.now() + 86_400_000), receivedAt });
      const stored = await setupClient.query('SELECT action_id, occurred_at, received_at FROM app.engagement_events WHERE recognition_id = $1', [claimed.recognition_id]);
      const occurredAt = (index: number) => stored.rows.find((row) => row.action_id === actionId(airing.campaignCard, index))?.occurred_at;
      expect(occurredAt(0)).toEqual(claimed.recognition_received_at);
      expect(occurredAt(1)).toEqual(receivedAt);
    });

    it('P4-ENGAGEMENTS-12: a tap retried in the next month is still stored once, and both sends succeed', async () => {
      const { airing, installId, claimed } = await answeredMatch();
      const callButton = actionId(airing.campaignCard);
      const now = new Date();
      const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 1));
      expect((await tap({ recognition: claimed, installId, stationId: airing.stationId, actionId: callButton })).answer).toBe('RECORDED');
      expect((await tap({ recognition: claimed, installId, stationId: airing.stationId, actionId: callButton, receivedAt: nextMonth })).answer).toBe('ALREADY_RECORDED');
      expect(await engagementRows(claimed.recognition_id)).toHaveLength(1);
      const key = await setupClient.query('SELECT engagement_received_at FROM app.engagement_deduplication_keys WHERE recognition_id = $1', [claimed.recognition_id]);
      expect((key.rows[0].engagement_received_at as Date).getUTCMonth()).toBe(now.getUTCMonth());
    });

    it('P4-LIMITS-04, -06 (database half): taps at once on many recognitions never push the counter past its limit', async () => {
      const recording = await testData.createRecording();
      const airing = await testData.airAd({ recording, engagementLimit: 5 });
      const taps: Tap[] = [];
      for (let listener = 0; listener < 12; listener += 1) {
        const { installId, claimed } = await answeredMatch({ recording, airing });
        taps.push({ recognition: claimed, installId, stationId: airing.stationId, actionId: actionId(airing.campaignCard) });
      }
      const connections = await Promise.all(
        Array.from({ length: 4 }, async () => {
          const connection = lookupApiClient();
          await connection.connect();
          return connection;
        }),
      );
      try {
        // Four connections tap at once, each sending its three taps one after another.
        const answers = await Promise.all(
          connections.map(async (connection, connectionIndex) => {
            const answered: string[] = [];
            for (const tapped of taps.filter((_tapped, index) => index % connections.length === connectionIndex)) {
              const result = await connection.query(
                'SELECT recognition.record_engagement($1, $2, $3, $4, $5, now(), now(), 0, now(), $6, NULL) AS answer',
                [recognitionIdAt(Date.now()), tapped.recognition.recognition_id, tapped.installId, tapped.stationId, tapped.actionId, 'request-race'],
              );
              answered.push(result.rows[0].answer as string);
            }
            return answered;
          }),
        );
        expect(answers.flat()).toEqual(Array(12).fill('RECORDED'));
      } finally {
        await Promise.all(connections.map((connection) => connection.end()));
      }
      expect(await counterOf(airing)).toBe(5);
      const counted = await setupClient.query('SELECT count(*) FILTER (WHERE is_counted)::integer AS counted, count(*)::integer AS stored FROM app.engagement_events WHERE campaign_id = $1', [airing.campaignId]);
      expect(counted.rows[0]).toEqual({ counted: 5, stored: 12 });
    });
  });

  // ---- recognition.record_recognition_report ---------------------------------------------------------------
  describe('recognition.record_recognition_report', () => {
    const installHash = () => randomBytes(16).toString('base64url').slice(0, 22);
    const report = async (recognitionId: string, installId: string, stationId: string, reason = 'LOOKS_LIKE_A_SCAM', hash = installHash()) =>
      (
        await apiClient.query('SELECT recognition.record_recognition_report($1, $2, $3, $4, $5, now(), $6) AS answer', [
          recognitionId,
          installId,
          hash,
          stationId,
          reason,
          `request-${randomUUID()}`,
        ])
      ).rows[0].answer as string;
    const reportRows = async (recognitionId: string) =>
      (await setupClient.query('SELECT * FROM app.recognition_reports WHERE recognition_id = $1', [recognitionId])).rows as Array<Record<string, unknown>>;

    it('P4-REPORTS-01: one report per recognition, the first reason kept; it stores the keyed hash of the install and never the install id', async () => {
      const { airing, installId, claimed } = await answeredMatch();
      const hash = installHash();
      expect(await report(claimed.recognition_id, installId, airing.stationId, 'LOOKS_LIKE_A_SCAM', hash)).toBe('RECORDED');
      expect(await report(claimed.recognition_id, installId, airing.stationId, 'SOMETHING_ELSE', hash)).toBe('ALREADY_RECORDED');
      const rows = await reportRows(claimed.recognition_id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ station_id: airing.stationId, reason: 'LOOKS_LIKE_A_SCAM', listener_install_hash: hash, recognition_received_at: claimed.recognition_received_at });
      expect(JSON.stringify(rows[0])).not.toContain(installId);
    });

    it('checks what a tap checks, without the action, and never records a choice', async () => {
      const { stationA, stationB, offAir, installId, claimed } = await answeredChooser();
      const match = await answeredMatch({ installId });
      expect(await report(recognitionIdAt(Date.now()), installId, stationA.stationId)).toBe('NOT_FOUND');
      expect(await report(claimed.recognition_id, await testData.createInstall(), stationA.stationId)).toBe('NOT_FOUND');
      expect(await report(match.claimed.recognition_id, installId, stationA.stationId)).toBe('NOT_A_CANDIDATE');
      expect(await report(claimed.recognition_id, installId, offAir.stationId)).toBe('NOT_A_CANDIDATE');
      const noMatch = await testData.claim(apiClient, installId);
      await testData.finish(apiClient, noMatch, { outcome: 'NO_MATCH' });
      expect(await report(noMatch.recognition_id, installId, stationA.stationId)).toBe('NOT_A_CANDIDATE');
      const pending = await testData.claim(apiClient, installId);
      expect(await report(pending.recognition_id, installId, stationA.stationId)).toBe('NOT_FOUND');

      // A report on a chooser nobody answered leaves it unanswered.
      expect(await report(claimed.recognition_id, installId, stationB.stationId)).toBe('RECORDED');
      expect(await chosenStations(claimed.recognition_id)).toEqual([]);
      expect((await eventRow(claimed.recognition_id)).resolution).toBe('UNRESOLVED');

      const answered = await answeredChooser();
      await apiClient.query('SELECT recognition.record_station_choice($1, $2, $3)', [answered.claimed.recognition_id, answered.installId, answered.stationA.stationId]);
      expect(await report(answered.claimed.recognition_id, answered.installId, answered.stationB.stationId)).toBe('ANOTHER_STATION_CHOSEN');
      expect(await reportRows(answered.claimed.recognition_id)).toEqual([]);
    });

    it('refuses a reason that is not one of the four, and a hash that is not a keyed hash', async () => {
      const { airing, installId, claimed } = await answeredMatch();
      await expect(report(claimed.recognition_id, installId, airing.stationId, 'SPAM')).rejects.toThrow(/unknown report reason/);
      await expect(report(claimed.recognition_id, installId, airing.stationId, 'LOOKS_LIKE_A_SCAM', installId)).rejects.toThrow(/recognition_reports_listener_install_hash_check/);
      expect(await reportRows(claimed.recognition_id)).toEqual([]);
    });
  });

  // ---- recognition.delete_expired_recognition_idempotency_keys ------------------------------------------
  describe('recognition.delete_expired_recognition_idempotency_keys', () => {
    const deleteExpired = async (olderThan: string, maximumCount: number) =>
      (await apiClient.query('SELECT recognition.delete_expired_recognition_idempotency_keys($1::interval, $2) AS deleted', [olderThan, maximumCount])).rows[0].deleted as number;

    it('refuses to delete keys younger than 25 hours, which a phone may still retry', async () => {
      for (const olderThan of ['24 hours', '1 day', '24:59:59']) {
        await expect(deleteExpired(olderThan, 10)).rejects.toThrow(/25 hours/);
      }
      await expect(deleteExpired('48 hours', 0)).rejects.toThrow(/maximum_count/);
    });

    it('P4-IDEMPOTENCY-19 (database half): deletes expired keys oldest first, at most the number asked for at a time, and keeps newer ones', async () => {
      const installId = await testData.createInstall();
      const keys: string[] = [];
      for (let key = 0; key < 3; key += 1) keys.push((await testData.claim(apiClient, installId)).recognition_id);
      const setMadeAt = (recognitionId: string, madeAt: string) =>
        setupClient.query(`UPDATE app.recognition_idempotency_keys SET created_at = $2::timestamptz WHERE recognition_event_id = $1`, [recognitionId, madeAt]);
      await setMadeAt(keys[0] as string, '1990-01-02T00:00:00Z');
      await setMadeAt(keys[1] as string, '1990-01-01T00:00:00Z');
      await setMadeAt(keys[2] as string, new Date(Date.now() - 47 * 3_600_000).toISOString());
      const remaining = async () =>
        (await setupClient.query('SELECT recognition_event_id FROM app.recognition_idempotency_keys WHERE listener_install_id = $1', [installId])).rows
          .map((row) => row.recognition_event_id as string)
          .sort();

      expect(await deleteExpired('48 hours', 1)).toBe(1);
      expect(await remaining()).toEqual([keys[0], keys[2]].sort());
      expect(await deleteExpired('48 hours', 1)).toBe(1);
      expect(await remaining()).toEqual([keys[2]]);
      await deleteExpired('48 hours', 1000);
      expect(await remaining()).toEqual([keys[2]]);
      // The recognitions themselves stay.
      expect((await setupClient.query('SELECT count(*)::integer AS kept FROM app.recognition_events WHERE id = ANY($1)', [keys])).rows[0].kept).toBe(3);
    });
  });
});
