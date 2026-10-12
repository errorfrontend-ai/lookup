import { randomUUID } from 'node:crypto';
import { RecognizeResponse } from '@lookup/contracts';
import type pg from 'pg';
import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InstallTokens } from '../src/common/listener-authentication/install-tokens.js';
import { RecognitionService } from '../src/features/recognition/recognition.service.js';
import { RecognizeQueue } from '../src/infrastructure/job-queues/recognize-queue.js';
import { databaseSetupClient } from './support/database-clients.js';
import { FakeRecognizeWorker, match, noMatch, recognize, registerInstall } from './support/listener-test-kit.js';
import { waitForLogWrites } from './support/log-capture.js';
import { type Recording, type StationAiring, StationResolutionTestData, type TimeWindowSpecification } from './support/station-resolution-test-data.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

/**
 * POST /api/v1/recognize deciding whose buttons a matched recording gets (P4 design §5.1, §6.4), against the real
 * API and database, with a stand-in worker that answers "this recording". Stations keep UTC time here, so a slot
 * can be placed a few hours around now on any day.
 */
describe('POST /api/v1/recognize: whose buttons a shared recording gets', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  let testData: StationResolutionTestData;
  let worker: FakeRecognizeWorker;
  let recognizeQueue: RecognizeQueue;
  const installRows: string[] = [];
  const runTag = randomUUID().slice(0, 6);
  const client = () => supertest(testApplication.application.getHttpServer());

  const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];
  const utcClock = (moment: Date) => moment.toISOString().slice(11, 16);
  const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3_600_000);
  /** One slot every day, from and to the given number of hours from now (UTC). */
  const slot = (fromHours: number, toHours: number): TimeWindowSpecification[] => [{ days: EVERY_DAY, from: utcClock(hoursFromNow(fromHours)), to: utcClock(hoursFromNow(toHours)) }];
  const THREE_HOURS = 3 * 3_600_000;

  /** A station of this run airing the recording: on air all day unless windows are given; UTC; no grace unless asked. */
  const air = (recording: Recording, name: string, options: Omit<Parameters<StationResolutionTestData['airAd']>[0], 'recording'> = {}) =>
    testData.airAd({ recording, gracePeriodMinutes: 0, ...options, station: { name: `Resolution ${runTag} ${name}`, timeZone: 'UTC', ...options.station } });

  async function newInstall() {
    const install = await registerInstall(client);
    const hash = testApplication.application.get(InstallTokens).hashInstallId(install.installId);
    const row = await setupClient.query('SELECT id FROM app.listener_installs WHERE install_id_hash = $1', [hash]);
    installRows.push(row.rows[0].id as string);
    return install;
  }

  /** A listener's clip of the recording, from a new install; every answer must pass the shared contract. */
  async function identify(recording: Recording, fields: Record<string, string | undefined> = {}) {
    worker.answer = () => match(recording.assetNumber);
    const { installToken } = await newInstall();
    const response = await recognize(client, { installToken, fields });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(RecognizeResponse.safeParse(response.body).success, JSON.stringify(response.body)).toBe(true);
    return response;
  }
  /** A clip heard three hours ago and sent now from the phone's saved clips. */
  const heardThreeHoursAgo = (extra: Record<string, string> = {}) => {
    const now = Date.now();
    return { captured_at: new Date(now - THREE_HOURS).toISOString(), sent_at: new Date(now).toISOString(), is_deferred: 'true', ...extra };
  };

  const eventRow = async (recognitionId: string) =>
    (await setupClient.query('SELECT outcome, resolution, fallback_reason, station_id, campaign_id, action_card_id, hinted_station_id FROM app.recognition_events WHERE id = $1', [recognitionId]))
      .rows[0] as Record<string, unknown>;
  const candidateRows = async (recognitionId: string) =>
    (
      await setupClient.query(
        `SELECT station_id, campaign_id, action_card_id, card_kind, is_in_window, display_position, is_chosen
           FROM app.recognition_candidates WHERE recognition_id = $1 ORDER BY display_position NULLS LAST, station_id`,
        [recognitionId],
      )
    ).rows as Array<Record<string, unknown>>;
  /** The candidate row a station gets with its campaign card, or with its client's usual card. */
  const weighed = (airing: StationAiring, kind: 'CAMPAIGN' | 'CLIENT_DEFAULT', isInWindow: boolean, displayPosition: number | null) => ({
    station_id: airing.stationId,
    campaign_id: airing.campaignId,
    action_card_id: kind === 'CAMPAIGN' ? airing.campaignCardId : airing.defaultCardId,
    card_kind: kind,
    is_in_window: isInWindow,
    display_position: displayPosition,
    is_chosen: false,
  });
  /** What the listener is shown of one station: its id and name, the card's kind and its buttons. */
  const shownAs = (airing: StationAiring, kind: 'CAMPAIGN' | 'CLIENT_DEFAULT') => ({
    kind,
    station: expect.objectContaining({ id: airing.stationId }),
    card: { schema_version: 1, layout: 'VERTICAL_STACK', header_image: null, actions: (kind === 'CAMPAIGN' ? airing.campaignCard : airing.defaultCard)?.actions },
  });
  const candidatesOf = (body: { candidates?: Array<{ station: { id: string } }> }) => (body.candidates ?? []).map((candidate) => candidate.station.id);

  beforeAll(async () => {
    testApplication = await createTestApplication();
    setupClient = databaseSetupClient();
    await setupClient.connect();
    testData = new StationResolutionTestData(setupClient);
    recognizeQueue = testApplication.application.get(RecognizeQueue);
    worker = new FakeRecognizeWorker(process.env.KEY_VALUE_STORE_URL as string, process.env.QUEUE_KEY_PREFIX as string);
    await worker.startHeartbeat();
    await recognizeQueue.refreshAdmission();
  });
  beforeEach(async () => {
    worker.answer = () => noMatch();
    testApplication.application.get(RecognitionService).circuitBreaker.close();
    await worker.startHeartbeat();
    await recognizeQueue.refreshAdmission();
  });
  afterAll(async () => {
    await worker.close();
    await setupClient.query(`DELETE FROM app.recognition_candidates WHERE recognition_id IN (SELECT id FROM app.recognition_events WHERE listener_install_id = ANY($1))`, [installRows]);
    await setupClient.query('DELETE FROM app.recognition_idempotency_keys WHERE listener_install_id = ANY($1)', [installRows]);
    await setupClient.query('DELETE FROM app.recognition_events WHERE listener_install_id = ANY($1)', [installRows]);
    await setupClient.query('DELETE FROM app.listener_installs WHERE id = ANY($1)', [installRows]);
    await testData.removeAll();
    await setupClient.end();
    await testApplication.close();
  });

  it('P4-RESOLUTION-05: two stations own the recording and one has it on air: that one’s buttons, stored as SCHEDULE_UNIQUE with both stations weighed', async () => {
    const recording = await testData.createRecording();
    const onAir = await air(recording, 'on air');
    const offAir = await air(recording, 'off air', { windows: slot(2, 3), hasDefaultCard: true });

    const response = await identify(recording);
    expect(response.body).toMatchObject({ status: 'MATCH', result: shownAs(onAir, 'CAMPAIGN') });
    expect(await eventRow(response.body.recognition_id)).toMatchObject({ outcome: 'MATCH', resolution: 'SCHEDULE_UNIQUE', station_id: onAir.stationId, action_card_id: onAir.campaignCardId });
    expect(await candidateRows(response.body.recognition_id)).toEqual(
      [weighed(onAir, 'CAMPAIGN', true, null), weighed(offAir, 'CLIENT_DEFAULT', false, null)].sort((first, second) => (first.station_id < second.station_id ? -1 : 1)),
    );
  });

  it('P4-RESOLUTION-07, -09, P4-CHOOSER-04: two stations with it on air and no hint: always asked, both stations’ full cards inline, never a match', async () => {
    const recording = await testData.createRecording();
    const stationA = await air(recording, 'A');
    const stationB = await air(recording, 'B');
    for (let send = 0; send < 3; send += 1) {
      const response = await identify(recording);
      expect(response.body.status).toBe('CHOOSE_STATION');
      expect(response.body).not.toHaveProperty('result');
      // Both slots started together, so the stations come by name.
      expect(response.body.candidates).toEqual([
        expect.objectContaining(shownAs(stationA, 'CAMPAIGN')),
        expect.objectContaining(shownAs(stationB, 'CAMPAIGN')),
      ]);
      expect(await eventRow(response.body.recognition_id)).toMatchObject({ outcome: 'CHOOSE_STATION', resolution: 'UNRESOLVED', station_id: null, campaign_id: null, action_card_id: null });
      expect(await candidateRows(response.body.recognition_id)).toEqual([weighed(stationA, 'CAMPAIGN', true, 1), weighed(stationB, 'CAMPAIGN', true, 2)]);
    }
  });

  it('P4-RESOLUTION-07: on air, the station whose slot started last is listed first', async () => {
    const recording = await testData.createRecording();
    const earlier = await air(recording, 'A', { windows: slot(-3, 2) });
    const later = await air(recording, 'B', { windows: slot(-1, 2) });
    const response = await identify(recording);
    expect(candidatesOf(response.body)).toEqual([later.stationId, earlier.stationId]);
  });

  it('P4-RESOLUTION-06: with the hint naming one of the stations on air: that station’s buttons, stored as HINT', async () => {
    const recording = await testData.createRecording();
    await air(recording, 'A');
    const hinted = await air(recording, 'B');
    const response = await identify(recording, { station_hint: hinted.stationId });
    expect(response.body).toMatchObject({ status: 'MATCH', result: shownAs(hinted, 'CAMPAIGN') });
    expect(await eventRow(response.body.recognition_id)).toMatchObject({ outcome: 'MATCH', resolution: 'HINT', station_id: hinted.stationId, hinted_station_id: hinted.stationId });
    expect(await candidateRows(response.body.recognition_id)).toHaveLength(2);
  });

  it('P4-RESOLUTION-08: a hint for a station that does not have it on air, or that is unknown, is ignored: still asked, without that station', async () => {
    const recording = await testData.createRecording();
    const stationA = await air(recording, 'A');
    const stationB = await air(recording, 'B');
    const offAir = await air(recording, 'C', { windows: slot(2, 3), hasDefaultCard: true });

    const withOffAirHint = await identify(recording, { station_hint: offAir.stationId });
    expect(withOffAirHint.body.status).toBe('CHOOSE_STATION');
    expect(candidatesOf(withOffAirHint.body)).toEqual([stationA.stationId, stationB.stationId]);
    // The hint names a station that exists, so it is kept; the station was weighed but not shown.
    expect(await eventRow(withOffAirHint.body.recognition_id)).toMatchObject({ resolution: 'UNRESOLVED', hinted_station_id: offAir.stationId });
    expect(await candidateRows(withOffAirHint.body.recognition_id)).toContainEqual(weighed(offAir, 'CLIENT_DEFAULT', false, null));

    const withUnknownHint = await identify(recording, { station_hint: randomUUID() });
    expect(candidatesOf(withUnknownHint.body)).toEqual([stationA.stationId, stationB.stationId]);
    expect((await eventRow(withUnknownHint.body.recognition_id)).hinted_station_id).toBeNull();
  });

  it('Correction 3: a hint naming a station that is not listed in the app is used when that station has it on air', async () => {
    const recording = await testData.createRecording();
    const unlisted = await air(recording, 'A', { station: { isListedInApp: false } });
    await air(recording, 'B');
    const response = await identify(recording, { station_hint: unlisted.stationId });
    expect(response.body).toMatchObject({ status: 'MATCH', result: shownAs(unlisted, 'CAMPAIGN') });
    expect((await eventRow(response.body.recognition_id)).resolution).toBe('HINT');
  });

  it('P4-FALLBACK-01: none has it on air and the hint names an owner: that owner’s usual buttons, stored as MATCH_DEFAULT by HINT', async () => {
    const recording = await testData.createRecording();
    const hinted = await air(recording, 'A', { windows: slot(2, 3), hasDefaultCard: true });
    await air(recording, 'B', { windows: slot(2, 3), hasDefaultCard: true });
    const response = await identify(recording, { station_hint: hinted.stationId });
    expect(response.body).toMatchObject({ status: 'MATCH', result: shownAs(hinted, 'CLIENT_DEFAULT') });
    expect(await eventRow(response.body.recognition_id)).toMatchObject({ outcome: 'MATCH_DEFAULT', resolution: 'HINT', action_card_id: hinted.defaultCardId, fallback_reason: 'not_on_air' });
  });

  it('P4-FALLBACK-02, -03: none has it on air and no hint: asked, each station with its usual buttons, the one on air most recently first', async () => {
    const recording = await testData.createRecording();
    const endedFiveHoursAgo = await air(recording, 'A', { windows: slot(-6, -5), hasDefaultCard: true });
    const endedTwoHoursAgo = await air(recording, 'B', { windows: slot(-3, -2), hasDefaultCard: true });
    const response = await identify(recording);
    expect(response.body.status).toBe('CHOOSE_STATION');
    expect(response.body.candidates).toEqual([
      expect.objectContaining(shownAs(endedTwoHoursAgo, 'CLIENT_DEFAULT')),
      expect.objectContaining(shownAs(endedFiveHoursAgo, 'CLIENT_DEFAULT')),
    ]);
    expect(await candidateRows(response.body.recognition_id)).toEqual([weighed(endedTwoHoursAgo, 'CLIENT_DEFAULT', false, 1), weighed(endedFiveHoursAgo, 'CLIENT_DEFAULT', false, 2)]);
  });

  it('P4-CHOOSER-02: five stations with it on air give the four whose slots started last; the fifth is weighed and not shown', async () => {
    const recording = await testData.createRecording();
    const stations: StationAiring[] = [];
    for (const [letter, startsHoursAgo] of [['A', 5], ['B', 4], ['C', 3], ['D', 2], ['E', 1]] as const) stations.push(await air(recording, letter, { windows: slot(-startsHoursAgo, 1) }));
    const response = await identify(recording);
    expect(candidatesOf(response.body)).toEqual([stations[4], stations[3], stations[2], stations[1]].map((station) => station?.stationId));
    const rows = await candidateRows(response.body.recognition_id);
    expect(rows).toHaveLength(5);
    expect(rows.find((row) => row.station_id === stations[0]?.stationId)?.display_position).toBeNull();
  });

  it('P4-CHOOSER-03, -07: every station in an answer carries its name, frequency, city (or null) and no logo, and nothing else', async () => {
    const recording = await testData.createRecording();
    const inKitwe = await air(recording, 'A', { station: { city: 'Kitwe', frequencyLabel: '104.3 FM' } });
    const withoutCity = await air(recording, 'B', { station: { city: null } });
    const response = await identify(recording);
    expect(response.body.candidates.map((candidate: { station: unknown }) => candidate.station)).toEqual([
      { id: inKitwe.stationId, name: `Resolution ${runTag} A`, frequency_label: '104.3 FM', city: 'Kitwe', logo: null },
      { id: withoutCity.stationId, name: `Resolution ${runTag} B`, frequency_label: '98.1 FM', city: null, logo: null },
    ]);
    const single = await testData.createRecording();
    await air(single, 'C', { station: { city: 'Ndola' } });
    expect((await identify(single)).body.result.station).toEqual(expect.objectContaining({ city: 'Ndola', logo: null }));
  });

  it('P4-RESOLUTION-14: a suspended station’s buttons are never given: one owner, the schedule, the hint, a chooser, a usual card, a clip sent later', async () => {
    const suspended = { station: { status: 'SUSPENDED' } };

    const singleOwner = await testData.createRecording();
    await air(singleOwner, 'only', { ...suspended, hasDefaultCard: true });
    expect((await identify(singleOwner)).body.status).toBe('NO_MATCH');

    // On air but suspended, beside an owner off air: the other's usual card, never the suspended station's.
    const schedule = await testData.createRecording();
    const suspendedOnAir = await air(schedule, 'suspended on air', suspended);
    const offAir = await air(schedule, 'off air', { windows: slot(2, 3), hasDefaultCard: true });
    const scheduleAnswer = await identify(schedule);
    expect(scheduleAnswer.body).toMatchObject({ status: 'MATCH', result: shownAs(offAir, 'CLIENT_DEFAULT') });
    expect(JSON.stringify(scheduleAnswer.body)).not.toContain(suspendedOnAir.stationId);

    const hint = await testData.createRecording();
    const hintedButSuspended = await air(hint, 'A', suspended);
    const active = await air(hint, 'B');
    const hintAnswer = await identify(hint, { station_hint: hintedButSuspended.stationId });
    expect(hintAnswer.body).toMatchObject({ status: 'MATCH', result: shownAs(active, 'CAMPAIGN') });

    const chooser = await testData.createRecording();
    const first = await air(chooser, 'A');
    const second = await air(chooser, 'B');
    const third = await air(chooser, 'C', suspended);
    const chooserAnswer = await identify(chooser);
    expect(candidatesOf(chooserAnswer.body)).toEqual([first.stationId, second.stationId]);
    expect(await candidateRows(chooserAnswer.body.recognition_id)).not.toContainEqual(expect.objectContaining({ station_id: third.stationId }));

    const usualCard = await testData.createRecording();
    await air(usualCard, 'usual', { ...suspended, windows: slot(2, 3), hasDefaultCard: true });
    expect((await identify(usualCard)).body.status).toBe('NO_MATCH');

    const sentLater = await testData.createRecording();
    await air(sentLater, 'later', { ...suspended, hasDefaultCard: true });
    const laterAnswer = await identify(sentLater, heardThreeHoursAgo());
    expect(laterAnswer.body).toMatchObject({ status: 'NO_MATCH', is_deferred: true });
    expect(await eventRow(laterAnswer.body.recognition_id)).toMatchObject({ outcome: 'NO_MATCH', fallback_reason: 'no_station_airs_it' });
  });

  it('P4-TIMERULE-05: a clip heard while the station was active and sent after it was suspended gets no buttons', async () => {
    const recording = await testData.createRecording();
    const airing = await air(recording, 'A', { hasDefaultCard: true });
    const heardEarlier = heardThreeHoursAgo();
    await setupClient.query(`UPDATE app.stations SET status = 'SUSPENDED' WHERE id = $1`, [airing.stationId]);
    expect((await identify(recording, heardEarlier)).body.status).toBe('NO_MATCH');
  });

  it('P4-TIMERULE-06: a clip heard on air and sent after the campaign was paused gets the client’s usual buttons; one heard after the pause gets none', async () => {
    const recording = await testData.createRecording();
    const airing = await air(recording, 'A', { hasDefaultCard: true });
    await setupClient.query(`UPDATE app.campaigns SET status = 'PAUSED' WHERE id = $1`, [airing.campaignId]);

    const heardBeforeThePause = await identify(recording, heardThreeHoursAgo());
    expect(heardBeforeThePause.body).toMatchObject({ status: 'MATCH', result: shownAs(airing, 'CLIENT_DEFAULT') });
    expect(await eventRow(heardBeforeThePause.body.recognition_id)).toMatchObject({ outcome: 'MATCH_DEFAULT', fallback_reason: 'campaign_not_active', campaign_id: airing.campaignId });

    // Heard (and sent) a moment after the pause: the campaign was no longer running, so the station is no owner.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const now = new Date().toISOString();
    const heardAfterThePause = await identify(recording, { captured_at: now, sent_at: now });
    expect(heardAfterThePause.body.status).toBe('NO_MATCH');
  });

  it('P4-TIMERULE-07: a clip heard before the card was edited and sent after gets the new buttons', async () => {
    const recording = await testData.createRecording();
    const airing = await air(recording, 'A');
    const heardEarlier = heardThreeHoursAgo();
    const edited = await testData.createCard(airing.stationId, airing.clientId);
    await setupClient.query('UPDATE app.campaigns SET action_card_id = $2 WHERE id = $1', [airing.campaignId, edited.cardId]);
    const response = await identify(recording, heardEarlier);
    expect(response.body.result.card.actions).toEqual(edited.content.actions);
    expect((await eventRow(response.body.recognition_id)).action_card_id).toBe(edited.cardId);
  });

  it('P4-RESOLUTION-10: the hint is stored on the recognition when its station exists, and nothing without one', async () => {
    const recording = await testData.createRecording();
    const airing = await air(recording, 'A');
    const withHint = await identify(recording, { station_hint: airing.stationId });
    expect((await eventRow(withHint.body.recognition_id)).hinted_station_id).toBe(airing.stationId);
    const withoutHint = await identify(recording);
    expect((await eventRow(withoutHint.body.recognition_id)).hinted_station_id).toBeNull();
    // A clip the engine does not know keeps the hint too: it is what the listener's phone said.
    worker.answer = () => noMatch();
    const { installToken } = await newInstall();
    const unmatched = await recognize(client, { installToken, fields: { station_hint: airing.stationId } });
    expect((await eventRow(unmatched.body.recognition_id)).hinted_station_id).toBe(airing.stationId);
  });

  it('owners exist but none has a card to show: NO_MATCH, stored with that reason', async () => {
    const recording = await testData.createRecording();
    await air(recording, 'A', { windows: slot(2, 3) });
    const response = await identify(recording);
    expect(response.body.status).toBe('NO_MATCH');
    expect(await eventRow(response.body.recognition_id)).toMatchObject({ outcome: 'NO_MATCH', fallback_reason: 'no_card_to_show', resolution: null });
    expect(await candidateRows(response.body.recognition_id)).toEqual([]);
  });

  it('P4-D26: the answer’s log line says whether a hint came, never its value, nor any card content', async () => {
    const recording = await testData.createRecording();
    await air(recording, 'A');
    const hinted = await air(recording, 'B');
    const response = await identify(recording, { station_hint: hinted.stationId });
    await waitForLogWrites();
    const answerLine = testApplication.logs.find((line) => line.requestId === response.headers['x-request-id'] && line.msg === 'recognition answered');
    expect(answerLine).toMatchObject({ outcome: 'MATCH', resolution: 'HINT', candidateCount: 2, hasStationHint: true, recognitionId: response.body.recognition_id });
    const logged = JSON.stringify(testApplication.logs.lines);
    expect(logged).not.toContain(hinted.stationId);
    expect(logged).not.toContain('+447700900');
    expect(logged).not.toContain((hinted.campaignCard?.actions[0] as { label: string }).label);
  });
});
