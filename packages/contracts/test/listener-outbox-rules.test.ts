import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  LISTENER_OUTBOX_ACKNOWLEDGEMENT_ACTIONS,
  LISTENER_OUTBOX_ANSWER_KINDS,
  LISTENER_OUTBOX_GROUP_OF_KIND,
  LISTENER_OUTBOX_ITEM_KINDS,
  LISTENER_OUTBOX_TIMING_RULES,
  type ListenerOutboxItemKind,
} from '../src/recognition/listener-outbox-rules.js';
import { readFixtureFile, readFixtureFolder } from './fixtures.js';

/**
 * The outbox fixtures the listener app's tests read (contract §3): the numbers both sides use, and one
 * row per acknowledgement case. The server half of R9 is here: every code a row names is in the API's
 * catalogue with that HTTP status. The catalogue is read from the API's source, like the envelope test.
 */
const apiSourceDirectory = resolve(import.meta.dirname, '..', '..', '..', 'apps', 'api', 'src');
const { ERROR_CATALOG } = (await import(pathToFileURL(resolve(apiSourceDirectory, 'common', 'errors', 'error-catalog.ts')).href)) as {
  ERROR_CATALOG: Record<string, { httpStatus: number; message: string }>;
};

const Wait = z.union([
  z.strictObject({ kind: z.literal('SECONDS'), seconds: z.number().int().min(1) }),
  z.strictObject({ kind: z.literal('RANDOM_SECONDS'), minimum_seconds: z.number().int().min(1), maximum_seconds: z.number().int().min(1) }),
  z.strictObject({ kind: z.literal('BACKOFF') }),
]);
const AcknowledgementRow = z.strictObject({
  item_kind: z.enum(LISTENER_OUTBOX_ITEM_KINDS),
  answer: z.enum(LISTENER_OUTBOX_ANSWER_KINDS),
  http_status: z.number().int().min(200).max(599).nullable(),
  http_status_class: z.enum(['2xx', '3xx', '4xx', '5xx']).nullable(),
  error_code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/).nullable(),
  retry_after_seconds: z.number().int().min(0).nullable(),
  action: z.enum(LISTENER_OUTBOX_ACKNOWLEDGEMENT_ACTIONS),
  wait: Wait.nullable(),
});
type AcknowledgementRow = z.infer<typeof AcknowledgementRow>;

const timingFixture = readFixtureFile<{ description: string; timing_rules: Record<string, number> }>('listener-outbox/timing-rules.json');
const acknowledgementFixture = readFixtureFile<{ description: string; rows: unknown[] }>('listener-outbox/acknowledgement-rules.json');
const rows = z.array(AcknowledgementRow).parse(acknowledgementFixture.rows);
const FOLLOW_UP_KINDS: ListenerOutboxItemKind[] = ['STATION_CHOICE', 'ENGAGEMENT', 'RECOGNITION_REPORT'];

/** The row the policy uses for an HTTP answer: the status with the code, else with no code, else the class. */
function decidingRow(kind: ListenerOutboxItemKind, httpStatus: number, errorCode: string | null): AcknowledgementRow | undefined {
  const forKind = rows.filter((row) => row.item_kind === kind && row.answer === 'HTTP');
  return (
    forKind.find((row) => row.http_status === httpStatus && errorCode !== null && row.error_code === errorCode) ??
    forKind.find((row) => row.http_status === httpStatus && row.error_code === null) ??
    forKind.find((row) => row.http_status_class === `${String(httpStatus)[0]}xx`)
  );
}

const rowFor = (kind: ListenerOutboxItemKind, httpStatus: number, errorCode: string | null, retryAfterSeconds: number | null) =>
  rows.find((row) => row.item_kind === kind && row.answer === 'HTTP' && row.http_status === httpStatus && row.error_code === errorCode && row.retry_after_seconds === retryAfterSeconds);

describe('the outbox timing rules', () => {
  it('timing-rules.json holds exactly the numbers of listener-outbox-rules.ts', () => {
    expect(timingFixture.timing_rules).toEqual(LISTENER_OUTBOX_TIMING_RULES);
  });

  it('are the numbers of contract §3', () => {
    expect(LISTENER_OUTBOX_TIMING_RULES).toEqual({
      maximum_stored_clips: 5,
      stored_clip_lifetime_seconds: 24 * 60 * 60,
      follow_up_item_lifetime_seconds: 7 * 24 * 60 * 60,
      maximum_follow_up_items: 200,
      maximum_queued_client_error_reports: 20,
      sending_delay_maximum_seconds: 120,
      sending_delay_for_new_item_while_online_maximum_seconds: 10,
      deferred_shed_retry_after_minimum_seconds: 60,
      deferred_shed_retry_after_maximum_seconds: 300,
      longest_honoured_retry_after_seconds: 3_600,
      backoff_first_wait_seconds: 30,
      backoff_longest_wait_seconds: 1_800,
      backoff_lowest_jitter_factor: 0.5,
      registrations_after_refused_token_per_run: 1,
      deferred_allowance_per_hour: 10,
      live_server_wait_milliseconds: 2_500,
      deferred_server_wait_milliseconds: 5_000,
    });
  });

  it('every item kind belongs to one pause group: clips, follow-ups or crash reports', () => {
    expect(Object.keys(LISTENER_OUTBOX_GROUP_OF_KIND).sort()).toEqual([...LISTENER_OUTBOX_ITEM_KINDS].sort());
    expect(FOLLOW_UP_KINDS.map((kind) => LISTENER_OUTBOX_GROUP_OF_KIND[kind])).toEqual(['FOLLOW_UPS', 'FOLLOW_UPS', 'FOLLOW_UPS']);
    expect(LISTENER_OUTBOX_GROUP_OF_KIND.DEFERRED_CLIP).toBe('CLIPS');
    expect(LISTENER_OUTBOX_GROUP_OF_KIND.CLIENT_ERROR_REPORT).toBe('CLIENT_ERROR_REPORTS');
  });
});

describe('the outbox acknowledgement rules', () => {
  it('every error code a row names is in the API catalogue with that HTTP status (R9, the server half)', () => {
    const rowsWithCodes = rows.filter((row) => row.error_code !== null);
    expect(rowsWithCodes.length).toBeGreaterThan(40);
    for (const row of rowsWithCodes) {
      expect(ERROR_CATALOG[row.error_code as string]?.httpStatus, `${row.item_kind} ${row.error_code}`).toBe(row.http_status);
    }
  });

  it('names each case once, and each row its answer in exactly one way', () => {
    const cases = rows.map((row) => JSON.stringify([row.item_kind, row.answer, row.http_status, row.http_status_class, row.error_code, row.retry_after_seconds]));
    expect(new Set(cases).size).toBe(cases.length);
    for (const row of rows) {
      const where = JSON.stringify(row);
      if (row.answer === 'HTTP') expect((row.http_status === null) !== (row.http_status_class === null), where).toBe(true);
      if (row.answer === 'HTTP_WITH_UNREADABLE_BODY') expect([row.http_status, row.http_status_class], where).toEqual([200, null]);
      if (row.answer === 'NO_ANSWER' || row.answer === 'PHONE_FAULT') expect([row.http_status, row.http_status_class, row.error_code, row.retry_after_seconds], where).toEqual([null, null, null, null]);
      // A default row for a status class names no code and no Retry-After: it is what any other answer of the class gets.
      if (row.http_status_class !== null) expect([row.error_code, row.retry_after_seconds], where).toEqual([null, null]);
    }
  });

  it('gives every kind an action for every status from 200 to 599, through the default rows (P6-D39)', () => {
    for (const kind of LISTENER_OUTBOX_ITEM_KINDS) {
      for (const statusClass of ['2xx', '3xx', '4xx', '5xx']) {
        expect(rows.some((row) => row.item_kind === kind && row.http_status_class === statusClass), `${kind} ${statusClass}`).toBe(true);
      }
      for (let httpStatus = 200; httpStatus <= 599; httpStatus += 1) expect(decidingRow(kind, httpStatus, null), `${kind} ${httpStatus}`).toBeDefined();
      for (const answer of ['NO_ANSWER', 'PHONE_FAULT'] as const) expect(rows.some((row) => row.item_kind === kind && row.answer === answer), `${kind} ${answer}`).toBe(true);
    }
  });

  it('gives each action its kind of wait', () => {
    const waitKindsByAction: Record<string, Array<string | null>> = {
      DELETE: [null],
      DELETE_AND_REPORT: [null],
      REGISTER_AGAIN_AND_RESEND: [null],
      PAUSE_ALL_UNTIL_APP_VERSION_CHANGES: [null],
      ITEM_WAITS: ['SECONDS'],
      ITEM_BACKS_OFF: ['BACKOFF'],
      ITEM_BACKS_OFF_AND_RUN_ENDS: ['BACKOFF'],
      PAUSE_GROUP: ['SECONDS', 'RANDOM_SECONDS'],
    };
    expect(Object.keys(waitKindsByAction).sort()).toEqual([...LISTENER_OUTBOX_ACKNOWLEDGEMENT_ACTIONS].sort());
    for (const row of rows) expect(waitKindsByAction[row.action], JSON.stringify(row)).toContain(row.wait?.kind ?? null);
  });

  it('honours a Retry-After exactly, clamped to 1 to 3,600 seconds, and otherwise waits 3 s after a 409 and 60 s after a 429', () => {
    const { longest_honoured_retry_after_seconds: longest } = LISTENER_OUTBOX_TIMING_RULES;
    const timed = rows.filter((row) => row.wait?.kind === 'SECONDS');
    expect(timed.length).toBeGreaterThan(20);
    for (const row of timed) {
      const expectedSeconds = row.retry_after_seconds !== null ? Math.min(Math.max(row.retry_after_seconds, 1), longest) : row.http_status === 409 ? 3 : 60;
      if (row.retry_after_seconds === null) expect([409, 429], JSON.stringify(row)).toContain(row.http_status);
      expect(row.wait, JSON.stringify(row)).toEqual({ kind: 'SECONDS', seconds: expectedSeconds });
    }
    expect(rows.some((row) => (row.retry_after_seconds ?? 0) > longest)).toBe(true);
    expect(rows.some((row) => row.retry_after_seconds === 0)).toBe(true);
  });

  it('a deferred clip: the shed 503 of 187 s and the 429 of 2,400 s pause clips; a 502, 503 or 504 with no Retry-After waits a random 60 to 300 s', () => {
    expect(rowFor('DEFERRED_CLIP', 503, 'RECOGNITION_BUSY', 187)).toMatchObject({ action: 'PAUSE_GROUP', wait: { kind: 'SECONDS', seconds: 187 } });
    expect(rowFor('DEFERRED_CLIP', 429, 'RATE_LIMITED', 2400)).toMatchObject({ action: 'PAUSE_GROUP', wait: { kind: 'SECONDS', seconds: 2400 } });
    const shedWait = {
      kind: 'RANDOM_SECONDS',
      minimum_seconds: LISTENER_OUTBOX_TIMING_RULES.deferred_shed_retry_after_minimum_seconds,
      maximum_seconds: LISTENER_OUTBOX_TIMING_RULES.deferred_shed_retry_after_maximum_seconds,
    };
    for (const httpStatus of [502, 503, 504]) expect(rowFor('DEFERRED_CLIP', httpStatus, null, null), String(httpStatus)).toMatchObject({ action: 'PAUSE_GROUP', wait: shedWait });
    expect(rows.filter((row) => row.wait?.kind === 'RANDOM_SECONDS').every((row) => row.item_kind === 'DEFERRED_CLIP')).toBe(true);
  });

  it('a deferred clip: a readable 200 is deleted, an unreadable one reported; a permanent refusal is deleted, a 409 waits for its own Retry-After', () => {
    expect(rowFor('DEFERRED_CLIP', 200, null, null)?.action).toBe('DELETE');
    expect(rows.find((row) => row.item_kind === 'DEFERRED_CLIP' && row.answer === 'HTTP_WITH_UNREADABLE_BODY')?.action).toBe('DELETE_AND_REPORT');
    for (const code of ['INVALID_AUDIO', 'CAPTURE_EXPIRED', 'CAPTURE_TIME_INVALID']) expect(decidingRow('DEFERRED_CLIP', ERROR_CATALOG[code]?.httpStatus as number, code)?.action, code).toBe('DELETE');
    expect(rowFor('DEFERRED_CLIP', 409, 'RECOGNITION_IN_PROGRESS', 3)).toMatchObject({ action: 'ITEM_WAITS', wait: { kind: 'SECONDS', seconds: 3 } });
  });

  it('the follow-ups: a 204 is deleted; each refusal of a choice, tap or report is deleted and reported; 401 registers again', () => {
    for (const kind of FOLLOW_UP_KINDS) {
      expect(rowFor(kind, 204, null, null)?.action, kind).toBe('DELETE');
      for (const code of ['VALIDATION_FAILED', 'NOT_FOUND', 'STATION_NOT_A_CANDIDATE', 'STATION_ALREADY_CHOSEN', 'ACTION_NOT_ON_CARD']) {
        expect(decidingRow(kind, ERROR_CATALOG[code]?.httpStatus as number, code)?.action, `${kind} ${code}`).toBe('DELETE_AND_REPORT');
      }
      expect(decidingRow(kind, 401, 'INSTALL_TOKEN_INVALID')?.action, kind).toBe('REGISTER_AGAIN_AND_RESEND');
    }
    expect(rowFor('ENGAGEMENT', 422, 'ACTION_NOT_ON_CARD', null)?.action).toBe('DELETE_AND_REPORT');
  });

  it('426 pauses every group until the app version changes, for every install-token route', () => {
    for (const kind of ['DEFERRED_CLIP', ...FOLLOW_UP_KINDS] as const) {
      expect(decidingRow(kind, 426, 'APP_UPDATE_REQUIRED')?.action, kind).toBe('PAUSE_ALL_UNTIL_APP_VERSION_CHANGES');
    }
  });

  it('a crash report is never reported about, and no answer ends the run for every kind', () => {
    expect(rows.filter((row) => row.item_kind === 'CLIENT_ERROR_REPORT').map((row) => row.action)).not.toContain('DELETE_AND_REPORT');
    expect(rowFor('CLIENT_ERROR_REPORT', 202, null, null)?.action).toBe('DELETE');
    for (const kind of LISTENER_OUTBOX_ITEM_KINDS) {
      expect(rows.find((row) => row.item_kind === kind && row.answer === 'NO_ANSWER')?.action, kind).toBe('ITEM_BACKS_OFF_AND_RUN_ENDS');
    }
  });

  it('every new error envelope leads somewhere in the follow-ups rows, by its status and code', () => {
    const envelopes = readFixtureFolder<{ http_status: number; body: { error: { code: string } } }>('errors/envelopes');
    for (const name of ['app-update-required', 'station-not-a-candidate', 'station-already-chosen', 'action-not-on-card', 'not-found']) {
      const envelope = envelopes.find((fixture) => fixture.name === name)?.fixture;
      expect(envelope, name).toBeDefined();
      const matching = rows.filter((row) => row.http_status === envelope?.http_status && row.error_code === envelope?.body.error.code);
      expect(matching.length, name).toBeGreaterThan(0);
    }
  });
});
