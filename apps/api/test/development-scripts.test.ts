import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertDevelopmentDatabase,
  resetSampleSchedule,
  runWalkthroughTool,
  setCampaignStatus,
  setStationStatus,
  showRecognitions,
  showReports,
  showTaps,
  WalkthroughToolProblem,
} from '../scripts/development-walkthrough-tools.js';
import { databaseSetupClient, lookupApiClient } from './support/database-clients.js';
import { type Recording, StationResolutionTestData } from './support/station-resolution-test-data.js';

/**
 * The development-only walkthrough tools (P4 design §5.15, P4-D25; P4-TOOLS-01): they refuse to run anywhere but on
 * this machine's database outside production, speak in plain words, and never print an install id, a key, a token,
 * a phone number or anything else from a card.
 */
describe('the development walkthrough tools', () => {
  let setupClient: pg.Client;
  let apiClient: pg.Client;
  let testData: StationResolutionTestData;
  const runTag = randomUUID().slice(0, 6);
  const environment = () => ({ setupUrl: process.env.DATABASE_SETUP_URL, nodeEnvironment: 'test' });

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

  const stationNamed = (letter: string) => `Tools ${runTag} ${letter}`;
  const airAt = (recording: Recording, letter: string, options: Omit<Parameters<StationResolutionTestData['airAd']>[0], 'recording'> = {}) =>
    testData.airAd({ recording, ...options, station: { name: stationNamed(letter), ...options.station } });

  describe('P4-TOOLS-01: where they may run', () => {
    it('refuses production, and any database that is not on this machine, without repeating the address', async () => {
      const remote = 'postgres://lookup_setup:secret-password-1234@db.example.com:5432/lookup';
      const refusals = [
        () => assertDevelopmentDatabase(process.env.DATABASE_SETUP_URL, 'production'),
        () => assertDevelopmentDatabase(remote, 'development'),
        () => assertDevelopmentDatabase('postgres://lookup_setup:secret-password-1234@10.0.0.5:5432/lookup', 'development'),
        () => assertDevelopmentDatabase(undefined, 'development'),
        () => assertDevelopmentDatabase('not an address', 'development'),
        // The driver lets these query settings replace the host, so a local-looking address could reach another database.
        () => assertDevelopmentDatabase('postgres://lookup_setup:secret-password-1234@localhost:5432/lookup?host=db.example.com', 'development'),
        () => assertDevelopmentDatabase('postgres://lookup_setup:secret-password-1234@127.0.0.1:5432/lookup?hostaddr=10.0.0.5', 'development'),
        () => assertDevelopmentDatabase('postgres://lookup_setup:secret-password-1234@localhost/lookup?sslmode=disable', 'development'),
        () => assertDevelopmentDatabase('mysql://lookup_setup:secret-password-1234@localhost/lookup', 'development'),
      ];
      for (const refusal of refusals) {
        expect(refusal).toThrow(WalkthroughToolProblem);
        try {
          refusal();
        } catch (error) {
          expect((error as Error).message).toMatch(/^Refused: /);
          expect((error as Error).message).not.toMatch(/secret-password|db\.example\.com|10\.0\.0\.5|lookup_setup/);
        }
      }
      for (const local of ['postgres://user:password@127.0.0.1:55432/lookup', 'postgresql://user:password@localhost/lookup', 'postgres://user:password@[::1]:5432/lookup']) {
        expect(() => assertDevelopmentDatabase(local, 'development'), local).not.toThrow();
      }
      // The tools connect with exactly the checked parts, so nothing in the address can redirect them.
      expect(assertDevelopmentDatabase('postgres://lookup%20setup:p%40ss@[::1]:55432/look%20up', 'development')).toEqual({
        host: '::1',
        port: 55432,
        user: 'lookup setup',
        password: 'p@ss',
        database: 'look up',
        application_name: 'lookup-development-walkthrough-tools',
      });
    });

    it('a refused tool never reaches the database: production and a remote address are refused before any connection', async () => {
      await expect(runWalkthroughTool(['show-recognitions'], { setupUrl: process.env.DATABASE_SETUP_URL, nodeEnvironment: 'production' })).rejects.toBeInstanceOf(WalkthroughToolProblem);
      // A host that does not exist: a connection attempt would fail with a lookup error instead of this refusal.
      await expect(runWalkthroughTool(['show-recognitions'], { setupUrl: 'postgres://user:password@no-such-host.invalid/lookup', nodeEnvironment: 'development' })).rejects.toBeInstanceOf(
        WalkthroughToolProblem,
      );
    });

    it('runs a tool by its name, and explains how to use them otherwise', async () => {
      const recording = await testData.createRecording();
      await airAt(recording, 'by name');
      expect(await runWalkthroughTool(['set-station-status', stationNamed('by name'), 'suspended'], environment())).toMatch(/is now SUSPENDED/);
      expect(await runWalkthroughTool(['set-station-status', stationNamed('by name'), 'ACTIVE'], environment())).toMatch(/is now ACTIVE/);
      for (const toolArguments of [['no-such-tool'], ['set-station-status', stationNamed('by name')], []]) {
        await expect(runWalkthroughTool(toolArguments, environment())).rejects.toThrow(/Use one of:/);
      }
    });
  });

  it('set-station-status suspends a station and makes it active again, in plain words, and refuses what it cannot do', async () => {
    const recording = await testData.createRecording();
    const airing = await airAt(recording, 'status');
    const statusOf = async () => (await setupClient.query('SELECT status FROM app.stations WHERE id = $1', [airing.stationId])).rows[0].status;

    expect(await setStationStatus(setupClient, stationNamed('status'), 'SUSPENDED')).toBe(
      `${stationNamed('status')} is now SUSPENDED (it was ACTIVE). Listeners get none of its buttons until it is ACTIVE again.`,
    );
    expect(await statusOf()).toBe('SUSPENDED');
    expect(await setStationStatus(setupClient, stationNamed('status'), 'SUSPENDED')).toBe(`${stationNamed('status')} was already SUSPENDED. Nothing changed.`);
    expect(await setStationStatus(setupClient, stationNamed('status'), 'ACTIVE')).toMatch(/is now ACTIVE \(it was SUSPENDED\)/);
    expect(await statusOf()).toBe('ACTIVE');

    await expect(setStationStatus(setupClient, stationNamed('status'), 'REJECTED')).rejects.toThrow('A station can be set to ACTIVE or SUSPENDED here, not "REJECTED".');
    await expect(setStationStatus(setupClient, `No such station ${runTag}`, 'ACTIVE')).rejects.toThrow(`There is no station called "No such station ${runTag}".`);
    await testData.createStation({ name: stationNamed('twin') });
    await testData.createStation({ name: stationNamed('twin') });
    await expect(setStationStatus(setupClient, stationNamed('twin'), 'SUSPENDED')).rejects.toThrow(/More than one station is called/);
  });

  it('set-campaign-status pauses, resumes and ends a campaign, and the database notes when; a draft is published in the portal instead', async () => {
    const recording = await testData.createRecording();
    const airing = await airAt(recording, 'campaign');
    const campaignOf = async () => (await setupClient.query('SELECT status, status_changed_at FROM app.campaigns WHERE id = $1', [airing.campaignId])).rows[0];
    const before = await campaignOf();

    expect(await setCampaignStatus(setupClient, stationNamed('campaign'), 'Summer service offer', 'PAUSED')).toBe(
      `${stationNamed('campaign')}'s "Summer service offer" campaign is now PAUSED (it was ACTIVE). Clips heard from now on get none of its buttons; clips heard before still get the client's usual buttons.`,
    );
    const paused = await campaignOf();
    expect(paused.status).toBe('PAUSED');
    expect((paused.status_changed_at as Date).getTime()).toBeGreaterThan((before.status_changed_at as Date).getTime());
    expect(await setCampaignStatus(setupClient, stationNamed('campaign'), 'Summer service offer', 'ACTIVE')).toMatch(/is now ACTIVE \(it was PAUSED\)/);
    expect(await setCampaignStatus(setupClient, stationNamed('campaign'), 'Summer service offer', 'ENDED')).toMatch(/is now ENDED \(it was ACTIVE\)/);
    await expect(setCampaignStatus(setupClient, stationNamed('campaign'), 'Summer service offer', 'ACTIVE')).rejects.toThrow(/is ENDED and cannot be set to ACTIVE here: give the ad new dates in the portal/);
    await expect(setCampaignStatus(setupClient, stationNamed('campaign'), 'Summer service offer', 'DRAFT')).rejects.toThrow(/can be set to ACTIVE, PAUSED, ENDED here, not "DRAFT"/);
    await expect(setCampaignStatus(setupClient, stationNamed('campaign'), 'No such ad', 'PAUSED')).rejects.toThrow(`${stationNamed('campaign')} has no ad called "No such ad".`);

    const draftRecording = await testData.createRecording();
    await airAt(draftRecording, 'draft', { campaignStatus: 'DRAFT' });
    await expect(setCampaignStatus(setupClient, stationNamed('draft'), 'Summer service offer', 'ACTIVE')).rejects.toThrow(/is DRAFT and cannot be set to ACTIVE here: publish it in the portal/);
  });

  it('reset-sample-schedule puts back the all-day slots with 10 minutes of grace, keeping the dates and the status', async () => {
    const recording = await testData.createRecording();
    const airing = await airAt(recording, 'schedule', { gracePeriodMinutes: 0, windows: [{ days: [1, 3], from: '05:00', to: '14:30' }] });
    const periodBefore = (await setupClient.query('SELECT active_period::text AS period FROM app.campaigns WHERE id = $1', [airing.campaignId])).rows[0].period;

    expect(await resetSampleSchedule(setupClient, stationNamed('schedule'), 'Summer service offer')).toBe(
      `${stationNamed('schedule')}'s "Summer service offer" airs all day, every day again (00:00 to 12:00 and 12:00 to 00:00), with 10 minutes of grace before and after each slot. Its campaign is ACTIVE.`,
    );
    const windows = await setupClient.query(
      `SELECT days_of_week, local_start_time::text AS start_time, local_end_time::text AS end_time FROM app.campaign_time_windows WHERE campaign_id = $1 ORDER BY local_start_time`,
      [airing.campaignId],
    );
    expect(windows.rows).toEqual([
      { days_of_week: [1, 2, 3, 4, 5, 6, 7], start_time: '00:00:00', end_time: '12:00:00' },
      { days_of_week: [1, 2, 3, 4, 5, 6, 7], start_time: '12:00:00', end_time: '00:00:00' },
    ]);
    const campaign = (await setupClient.query(`SELECT status, active_period::text AS period, extract(epoch FROM time_window_grace_period)::integer AS grace_seconds FROM app.campaigns WHERE id = $1`, [airing.campaignId])).rows[0];
    expect(campaign).toEqual({ status: 'ACTIVE', period: periodBefore, grace_seconds: 600 });
  });

  it('show-recognitions says what each recognition answered and why, newest first, with names only: no install, key, token, card content or number', async () => {
    const installId = await testData.createInstall();
    const key = randomUUID();
    const shared = await testData.createRecording();
    const stationA = await airAt(shared, 'A', { station: { frequencyLabel: '98.1 FM', city: 'Lusaka' }, hasDefaultCard: true });
    const stationB = await airAt(shared, 'B', { station: { frequencyLabel: '104.3 FM', city: 'Kitwe' } });
    const finishAt = async (secondsAgo: number, finished: Parameters<StationResolutionTestData['finish']>[2], options: { key?: string; isDeferred?: boolean; heardSecondsBefore?: number } = {}) => {
      const receivedAt = new Date(Date.now() - secondsAgo * 1_000);
      const claimed = await testData.claim(apiClient, installId, {
        key: options.key,
        receivedAt,
        capturedAt: new Date(receivedAt.getTime() - (options.heardSecondsBefore ?? 5) * 1_000),
        isDeferred: options.isDeferred,
      });
      expect(await testData.finish(apiClient, claimed, { recording: shared, ...finished })).toBe(true);
      return claimed;
    };
    const candidate = StationResolutionTestData.candidate;

    // Oldest first: no match; the client's usual card; the schedule; a deferred match by the only owner; a chooser, chosen; a chooser, open.
    await finishAt(60, { outcome: 'NO_MATCH', fallbackReason: 'no_station_airs_it' });
    await finishAt(50, {
      outcome: 'MATCH_DEFAULT',
      resolution: 'SINGLE_OWNER',
      fallbackReason: 'not_on_air',
      shown: { stationId: stationA.stationId, campaignId: stationA.campaignId, cardId: stationA.defaultCardId as string },
      candidates: [candidate(stationA, { kind: 'CLIENT_DEFAULT', isInWindow: false })],
    });
    await finishAt(40, {
      outcome: 'MATCH',
      resolution: 'SCHEDULE_UNIQUE',
      shown: { stationId: stationB.stationId, campaignId: stationB.campaignId, cardId: stationB.campaignCardId as string },
      candidates: [candidate(stationA, { kind: 'CLIENT_DEFAULT', isInWindow: false }), candidate(stationB)],
    });
    await finishAt(
      30,
      { outcome: 'MATCH', resolution: 'SINGLE_OWNER', shown: { stationId: stationB.stationId, campaignId: stationB.campaignId, cardId: stationB.campaignCardId as string }, candidates: [candidate(stationB)] },
      { isDeferred: true, heardSecondsBefore: 3 * 3_600 + 120 },
    );
    const chosen = await finishAt(20, { outcome: 'CHOOSE_STATION', resolution: 'UNRESOLVED', candidates: [candidate(stationA, { displayPosition: 1 }), candidate(stationB, { displayPosition: 2 })] });
    expect((await apiClient.query('SELECT recognition.record_station_choice($1, $2, $3) AS answer', [chosen.recognition_id, installId, stationB.stationId])).rows[0].answer).toBe('CHOSEN');
    await finishAt(10, { outcome: 'CHOOSE_STATION', resolution: 'UNRESOLVED', candidates: [candidate(stationA, { displayPosition: 1 }), candidate(stationB, { displayPosition: 2 })] }, { key });

    const shown = await showRecognitions(setupClient, { count: 10, timeZone: 'Africa/Lusaka', listenerInstallIds: [installId] });
    const lines = shown.split('\n');
    // A time today, or a day and a time when it was another day in Lusaka (a clip heard 3 hours ago, just after midnight).
    const time = String.raw`(?:\d{1,2} [A-Z][a-z]{2} )?\d{2}:\d{2}:\d{2}`;
    expect(lines[0]).toBe('The latest 6 recognitions, newest first (times in Africa/Lusaka):');
    expect(lines.slice(1)).toEqual([
      expect.stringMatching(new RegExp(`^${time}  heard ${time}, sent at once$`)),
      `          Asked "Which station?": 1. ${stationNamed('A')} (98.1 FM · Lusaka)  2. ${stationNamed('B')} (104.3 FM · Kitwe)`,
      '          Not chosen yet',
      expect.stringMatching(new RegExp(`^${time}  heard ${time}, sent at once$`)),
      `          Asked "Which station?": 1. ${stationNamed('A')} (98.1 FM · Lusaka)  2. ${stationNamed('B')} (104.3 FM · Kitwe)`,
      `          Chosen by the listener: ${stationNamed('B')}`,
      expect.stringMatching(new RegExp(`^${time}  heard ${time}, sent later \\(3 h 2 min after\\)$`)),
      `          ${stationNamed('B')} — Brand A, "Summer service offer", the campaign's buttons`,
      '          Decided by: only one station can answer',
      expect.stringMatching(new RegExp(`^${time}  heard ${time}, sent at once$`)),
      `          ${stationNamed('B')} — Brand A, "Summer service offer", the campaign's buttons`,
      `          Decided by: the schedule (only ${stationNamed('B')} had it on air)`,
      expect.stringMatching(new RegExp(`^${time}  heard ${time}, sent at once$`)),
      `          ${stationNamed('A')} — Brand A, "Summer service offer", Brand A's usual buttons (the ad was not on air when it was heard)`,
      '          Decided by: only one station can answer',
      expect.stringMatching(new RegExp(`^${time}  heard ${time}, sent at once$`)),
      '          No match: no active station airs this recording',
    ]);

    const cards = [stationA.campaignCard, stationA.defaultCard, stationB.campaignCard];
    const cardWords = cards.flatMap((card) => card?.actions.map((action) => action.label) ?? []);
    for (const forbidden of [installId, key, chosen.recognition_id, '+447700900', 'example.com', ...cardWords]) expect(shown, forbidden).not.toContain(forbidden);
    expect(shown).not.toMatch(/eyJ[A-Za-z0-9_-]+\./);
  });

  it('show-reports lists the latest reports with the time, the station, the reason in the sheet’s words and the start of the phone’s hash only', async () => {
    const installId = await testData.createInstall();
    const otherInstallId = await testData.createInstall();
    const recording = await testData.createRecording();
    const station = await airAt(recording, 'Reported', { station: { frequencyLabel: '98.1 FM', city: 'Lusaka' } });
    const candidate = StationResolutionTestData.candidate;
    const hashOf = (install: string) => `${install.replace(/-/g, '').slice(0, 20)}AB`;
    const reportOn = async (install: string, reason: string, secondsAgo: number) => {
      const claimed = await testData.claim(apiClient, install, { receivedAt: new Date(Date.now() - secondsAgo * 1_000) });
      await testData.finish(apiClient, claimed, {
        outcome: 'MATCH',
        resolution: 'SINGLE_OWNER',
        recording,
        shown: { stationId: station.stationId, campaignId: station.campaignId, cardId: station.campaignCardId as string },
        candidates: [candidate(station)],
      });
      const answer = await apiClient.query('SELECT recognition.record_recognition_report($1, $2, $3, $4, $5, now(), $6) AS answer', [
        claimed.recognition_id, install, hashOf(install), station.stationId, reason, `request-${randomUUID()}`,
      ]);
      expect(answer.rows[0].answer).toBe('RECORDED');
      return claimed;
    };
    const first = await reportOn(installId, 'LOOKS_LIKE_A_SCAM', 30);
    await reportOn(installId, 'NUMBER_OR_LINK_DOES_NOT_WORK', 20);
    await reportOn(otherInstallId, 'WRONG_OR_MISLEADING_BUTTONS', 10);

    const shown = await showReports(setupClient, { count: 10, timeZone: 'Africa/Lusaka', stationIds: [station.stationId] });
    const time = String.raw`(?:\d{1,2} [A-Z][a-z]{2} )?\d{2}:\d{2}:\d{2}`;
    const where = `${stationNamed('Reported')} \\(98\\.1 FM · Lusaka\\)`;
    expect(shown.split('\n')).toEqual([
      'The latest 3 reports, newest first (times in Africa/Lusaka):',
      expect.stringMatching(new RegExp(`^${time}  ${where}: "The buttons are wrong or misleading" — phone ${hashOf(otherInstallId).slice(0, 6)}$`)),
      expect.stringMatching(new RegExp(`^${time}  ${where}: "A number or link doesn't work" — phone ${hashOf(installId).slice(0, 6)}$`)),
      expect.stringMatching(new RegExp(`^${time}  ${where}: "It looks like a scam" — phone ${hashOf(installId).slice(0, 6)}$`)),
    ]);
    for (const forbidden of [installId, otherInstallId, hashOf(installId), first.recognition_id, '+447700900', 'example.com']) expect(shown, forbidden).not.toContain(forbidden);
    expect(await showReports(setupClient, { stationIds: [randomUUID()] })).toBe('No reports yet.');
  });
  it('show-taps lists the latest taps with the time, the station, the button’s label and how each counted, and nothing else from the card', async () => {
    const installId = await testData.createInstall();
    const recording = await testData.createRecording();
    const station = await airAt(recording, 'Tapped', { engagementLimit: 2, hasDefaultCard: true, station: { frequencyLabel: '98.1 FM', city: 'Lusaka' } });
    const finished = async (kind: 'CAMPAIGN' | 'CLIENT_DEFAULT', secondsAgo: number) => {
      const claimed = await testData.claim(apiClient, installId, { receivedAt: new Date(Date.now() - secondsAgo * 1_000) });
      await testData.finish(apiClient, claimed, {
        outcome: kind === 'CAMPAIGN' ? 'MATCH' : 'MATCH_DEFAULT',
        fallbackReason: kind === 'CAMPAIGN' ? null : 'campaign_at_tap_limit',
        resolution: 'SINGLE_OWNER',
        recording,
        shown: { stationId: station.stationId, campaignId: station.campaignId, cardId: (kind === 'CAMPAIGN' ? station.campaignCardId : station.defaultCardId) as string },
        candidates: [StationResolutionTestData.candidate(station, { kind })],
      });
      return claimed;
    };
    const tap = async (recognitionId: string, actionId: string) => {
      const answer = await apiClient.query('SELECT recognition.record_engagement($1, $2, $3, $4, $5, now(), now(), 0, now(), $6, NULL) AS answer', [
        randomUUID(), recognitionId, installId, station.stationId, actionId, `request-${randomUUID()}`,
      ]);
      expect(answer.rows[0].answer).toBe('RECORDED');
    };
    const campaignActions = station.campaignCard?.actions as Array<{ id: string; label: string }>;
    const usualActions = station.defaultCard?.actions as Array<{ id: string; label: string }>;
    const first = await finished('CAMPAIGN', 40);
    await tap(first.recognition_id, campaignActions[0]!.id);
    await tap(first.recognition_id, campaignActions[1]!.id);
    await tap(first.recognition_id, campaignActions[2]!.id);
    const usual = await finished('CLIENT_DEFAULT', 20);
    await tap(usual.recognition_id, usualActions[0]!.id);

    const shown = await showTaps(setupClient, { count: 10, timeZone: 'Africa/Lusaka', stationIds: [station.stationId] });
    const time = String.raw`(?:\d{1,2} [A-Z][a-z]{2} )?\d{2}:\d{2}:\d{2}`;
    const where = `${stationNamed('Tapped')} \\(98\\.1 FM · Lusaka\\)`;
    expect(shown.split('\n')).toEqual([
      'The latest 4 taps, newest first (times in Africa/Lusaka):',
      expect.stringMatching(new RegExp(`^${time}  ${where}: "Call us" — stored, not counted \\(usual buttons\\)$`)),
      expect.stringMatching(new RegExp(`^${time}  ${where}: "See the offer" — stored, not counted \\(the tap limit was reached\\)$`)),
      expect.stringMatching(new RegExp(`^${time}  ${where}: "Chat with us" — counted, 2 of 2$`)),
      expect.stringMatching(new RegExp(`^${time}  ${where}: "Call us" — counted, 1 of 2$`)),
    ]);
    for (const forbidden of [installId, first.recognition_id, campaignActions[0]!.id, '+447700900', 'example.com', 'Hi, I heard']) expect(shown, forbidden).not.toContain(forbidden);
    expect(await showTaps(setupClient, { stationIds: [randomUUID()] })).toBe('No taps yet.');
  });
});
