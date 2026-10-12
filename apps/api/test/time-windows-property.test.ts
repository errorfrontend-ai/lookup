import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseSetupClient } from './support/database-clients.js';

/**
 * P4-TESTS-05 (P4-D23): the database's window rule against a plain reference written here, over 1,000 cases
 * drawn from a seeded generator (no package). The seed is printed; LOOKUP_PROPERTY_SEED=<seed> repeats a run.
 *
 * The reference does not list slots as the database does: it works on the week as a circle of seconds. A window
 * on day d from s to e is the arc that starts at d·86,400 + s and lasts (e − s) seconds, or a day longer when it
 * runs past midnight; with grace g, a moment m is on air when (m − (start − g)) modulo the week is under the
 * arc's length + 2g.
 */
const CASE_COUNT = 1_000;
const GRACE_MINUTES = [0, 5, 10, 20, 60];
const WEEK_SECONDS = 7 * 86_400;
/** Monday 5 October 2026, 00:00, the start of the three weeks the moments are drawn from. */
const FIRST_MONDAY = Date.UTC(2026, 9, 5);

/** mulberry32: a small, well-known seeded generator of numbers in [0, 1). */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface WindowCase {
  days: number[];
  startMinute: number;
  endMinute: number;
  graceMinutes: number;
  /** Seconds since FIRST_MONDAY, in the station's wall-clock time. */
  momentSeconds: number;
}

function referenceIsOpen(windowCase: WindowCase): boolean {
  const startSeconds = windowCase.startMinute * 60;
  const endSeconds = windowCase.endMinute * 60;
  const lengthSeconds = endSeconds > startSeconds ? endSeconds - startSeconds : endSeconds - startSeconds + 86_400;
  const graceSeconds = windowCase.graceMinutes * 60;
  return windowCase.days.some((isoDay) => {
    const arcStart = (isoDay - 1) * 86_400 + startSeconds - graceSeconds;
    const distance = (((windowCase.momentSeconds - arcStart) % WEEK_SECONDS) + WEEK_SECONDS) % WEEK_SECONDS;
    return distance < lengthSeconds + 2 * graceSeconds;
  });
}

function drawCases(random: () => number): WindowCase[] {
  const whole = (below: number) => Math.floor(random() * below);
  return Array.from({ length: CASE_COUNT }, (_unused, caseIndex) => {
    const days = [1, 2, 3, 4, 5, 6, 7].filter(() => random() < 0.4);
    if (days.length === 0) days.push(whole(7) + 1);
    const startMinute = whole(1_440);
    let endMinute = whole(1_440);
    if (endMinute === startMinute) endMinute = (startMinute + 1 + whole(1_439)) % 1_440;
    const graceMinutes = GRACE_MINUTES[whole(GRACE_MINUTES.length)] as number;
    // Half the moments fall anywhere in three weeks; the other half near a slot's start or end, where the rule
    // can go wrong: half of those exactly on a boundary of the slot or of its grace, give or take a second, the
    // rest anywhere within the grace and two minutes more on either side.
    let momentSeconds = whole(3 * WEEK_SECONDS);
    if (caseIndex % 2 === 1) {
      const day = days[whole(days.length)] as number;
      const week = whole(3);
      const edgeMinute = random() < 0.5 ? startMinute : endMinute + (endMinute <= startMinute ? 1_440 : 0);
      const boundarySeconds = ([-graceMinutes, 0, graceMinutes][whole(3)] as number) * 60 + whole(3) - 1;
      const offsetSeconds = random() < 0.5 ? boundarySeconds : whole((2 * graceMinutes + 4) * 60) - (graceMinutes + 2) * 60;
      momentSeconds = Math.max(0, Math.min(3 * WEEK_SECONDS - 1, week * WEEK_SECONDS + (day - 1) * 86_400 + edgeMinute * 60 + offsetSeconds));
    }
    return { days, startMinute, endMinute, graceMinutes, momentSeconds };
  });
}

const clock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const localMoment = (seconds: number) => new Date(FIRST_MONDAY + seconds * 1000).toISOString().replace('T', ' ').slice(0, 19);

describe('time windows: the database rule against a reference, over seeded random cases', () => {
  let setupClient: pg.Client;
  beforeAll(async () => {
    setupClient = databaseSetupClient();
    await setupClient.connect();
  });
  afterAll(async () => setupClient.end());

  it('P4-TESTS-05: app.is_time_window_open_with_grace equals the reference in 1,000 cases, and with no grace equals app.is_time_window_open', async () => {
    const seed = process.env.LOOKUP_PROPERTY_SEED ? Number(process.env.LOOKUP_PROPERTY_SEED) : Math.floor(Math.random() * 2 ** 31);
    console.info(`time-window property cases: seed ${seed} (repeat with LOOKUP_PROPERTY_SEED=${seed})`);
    const cases = drawCases(seededRandom(seed));

    // Every case in one query.
    const answers = (
      await setupClient.query(
        `SELECT window_case.case_index,
                app.is_time_window_open_with_grace(window_case.days::smallint[], window_case.start_time::time, window_case.end_time::time,
                                                   window_case.local_moment::timestamp, make_interval(mins => window_case.grace_minutes)) AS is_open_with_grace,
                app.is_time_window_open(window_case.days::smallint[], window_case.start_time::time, window_case.end_time::time,
                                        window_case.local_moment::timestamp) AS is_open_without_grace
           FROM unnest($1::integer[], $2::text[], $3::text[], $4::text[], $5::text[], $6::integer[])
                AS window_case(case_index, days, start_time, end_time, local_moment, grace_minutes)
          ORDER BY window_case.case_index`,
        [
          cases.map((_windowCase, index) => index),
          cases.map((windowCase) => `{${windowCase.days.join(',')}}`),
          cases.map((windowCase) => clock(windowCase.startMinute)),
          cases.map((windowCase) => clock(windowCase.endMinute)),
          cases.map((windowCase) => localMoment(windowCase.momentSeconds)),
          cases.map((windowCase) => windowCase.graceMinutes),
        ],
      )
    ).rows as Array<{ case_index: number; is_open_with_grace: boolean; is_open_without_grace: boolean }>;
    expect(answers).toHaveLength(CASE_COUNT);

    const describeCase = (index: number) => {
      const windowCase = cases[index] as WindowCase;
      return `seed ${seed}, case ${index}: days {${windowCase.days.join(',')}} ${clock(windowCase.startMinute)}–${clock(windowCase.endMinute)}, grace ${windowCase.graceMinutes} min, at ${localMoment(windowCase.momentSeconds)}`;
    };
    const disagreements = answers
      .filter((answer) => answer.is_open_with_grace !== referenceIsOpen(cases[answer.case_index] as WindowCase))
      .map((answer) => `${describeCase(answer.case_index)}: database ${answer.is_open_with_grace}`);
    expect(disagreements).toEqual([]);
    const disagreementsWithoutGrace = answers
      .filter((answer) => (cases[answer.case_index] as WindowCase).graceMinutes === 0 && answer.is_open_with_grace !== answer.is_open_without_grace)
      .map((answer) => describeCase(answer.case_index));
    expect(disagreementsWithoutGrace).toEqual([]);

    // The cases are not one-sided: both answers come up often, and every grace is drawn.
    expect(answers.filter((answer) => answer.is_open_with_grace).length).toBeGreaterThan(150);
    expect(answers.filter((answer) => !answer.is_open_with_grace).length).toBeGreaterThan(150);
    for (const graceMinutes of GRACE_MINUTES) expect(cases.some((windowCase) => windowCase.graceMinutes === graceMinutes)).toBe(true);
  });

  it('the reference itself agrees with cases worked out by hand', () => {
    // Friday (5) 22:00 to 02:00 with 10 minutes of grace; FIRST_MONDAY + 4 days is Friday.
    const friday = 4 * 86_400;
    const overnight = (momentSeconds: number) => referenceIsOpen({ days: [5], startMinute: 22 * 60, endMinute: 2 * 60, graceMinutes: 10, momentSeconds });
    expect(overnight(friday + 21 * 3600 + 51 * 60)).toBe(true);
    expect(overnight(friday + 21 * 3600 + 49 * 60)).toBe(false);
    expect(overnight(friday + 86_400 + 2 * 3600 + 9 * 60)).toBe(true);
    expect(overnight(friday + 86_400 + 2 * 3600 + 10 * 60)).toBe(false);
    expect(overnight(friday + 3600)).toBe(false);
    // Sunday (7) 23:00 to 01:00 wraps around the end of the week into Monday.
    const sunday = (momentSeconds: number) => referenceIsOpen({ days: [7], startMinute: 23 * 60, endMinute: 60, graceMinutes: 0, momentSeconds });
    expect(sunday(30 * 60)).toBe(true);
    expect(sunday(WEEK_SECONDS - 30 * 60)).toBe(true);
    expect(sunday(23 * 3600 + 30 * 60)).toBe(false);
  });
});
