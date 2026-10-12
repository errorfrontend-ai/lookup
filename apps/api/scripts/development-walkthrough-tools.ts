/**
 * Development-only tools for the live walkthroughs (P4 design §5.15, P4-D25; P4-TOOLS-01). Pausing a campaign or
 * suspending a station has no screen until P5B and 5a, and the walkthroughs check what the server decided, so these
 * do it from a terminal, in plain words:
 *
 *   npm run development:show-recognitions
 *   npm run development:set-station-status -- "Station B" SUSPENDED        (or ACTIVE)
 *   npm run development:set-campaign-status -- "Station B" "Summer service offer" PAUSED   (or ACTIVE, ENDED)
 *   npm run development:reset-sample-schedule -- "Station A" "Summer service offer"
 *
 * Each refuses to run unless the setup database is on this machine and NODE_ENV is not production. None prints an
 * install id, a token, a phone number or anything else from a card: stations, clients and ads by name only.
 */
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { loadDatabaseSetupConfig } from './database-setup-config.js';

/** A refusal or a failure written for the person at the terminal; nothing technical, nothing secret. */
export class WalkthroughToolProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalkthroughToolProblem';
  }
}

const HOSTS_ON_THIS_MACHINE = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Refuses unless NODE_ENV is not production and the setup database address points at this machine. The address
 * holds a password, so it is never repeated, not even in a refusal.
 */
export function assertDevelopmentDatabase(setupUrl: string | undefined, nodeEnvironment: string | undefined): void {
  if (nodeEnvironment === 'production') throw new WalkthroughToolProblem('Refused: these tools are for development only, and NODE_ENV is "production".');
  let hostname: string;
  try {
    hostname = new URL(setupUrl ?? '').hostname.toLowerCase();
  } catch {
    throw new WalkthroughToolProblem('Refused: the setup database address (DATABASE_SETUP_URL) is missing or cannot be read.');
  }
  if (!HOSTS_ON_THIS_MACHINE.has(hostname)) {
    throw new WalkthroughToolProblem('Refused: these tools only work on a database on this machine, and DATABASE_SETUP_URL points somewhere else.');
  }
}

type Database = Pick<pg.Client, 'query'>;

/** The one station with this name, or a plain refusal. */
async function findStation(database: Database, stationName: string): Promise<{ id: string; name: string; status: string }> {
  const stations = (await database.query(`SELECT id, name, status FROM app.stations WHERE name = $1`, [stationName])).rows as Array<{ id: string; name: string; status: string }>;
  if (stations.length === 0) throw new WalkthroughToolProblem(`There is no station called "${stationName}".`);
  if (stations.length > 1) throw new WalkthroughToolProblem(`More than one station is called "${stationName}", so nothing was changed.`);
  return stations[0] as { id: string; name: string; status: string };
}

/** The latest campaign of the station's one ad with this title (archived ads left out), or a plain refusal. */
async function findCampaign(database: Database, stationName: string, adTitle: string): Promise<{ stationId: string; campaignId: string; status: string }> {
  const station = await findStation(database, stationName);
  const ads = (await database.query(`SELECT id FROM app.ads WHERE station_id = $1 AND title = $2 AND archived_at IS NULL`, [station.id, adTitle])).rows as Array<{ id: string }>;
  if (ads.length === 0) throw new WalkthroughToolProblem(`${stationName} has no ad called "${adTitle}".`);
  if (ads.length > 1) throw new WalkthroughToolProblem(`${stationName} has more than one ad called "${adTitle}", so nothing was changed.`);
  const campaign = (
    await database.query(`SELECT id, status FROM app.campaigns WHERE ad_id = $1 ORDER BY created_at DESC LIMIT 1`, [(ads[0] as { id: string }).id])
  ).rows[0] as { id: string; status: string } | undefined;
  if (!campaign) throw new WalkthroughToolProblem(`"${adTitle}" at ${stationName} has no schedule yet. Set one in the portal first.`);
  return { stationId: station.id, campaignId: campaign.id, status: campaign.status };
}

export const SETTABLE_STATION_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;

/** Suspends a station or makes it ACTIVE again. A suspended station never gives a listener its buttons. */
export async function setStationStatus(database: Database, stationName: string, status: string): Promise<string> {
  if (!(SETTABLE_STATION_STATUSES as readonly string[]).includes(status)) {
    throw new WalkthroughToolProblem(`A station can be set to ${SETTABLE_STATION_STATUSES.join(' or ')} here, not "${status}".`);
  }
  const station = await findStation(database, stationName);
  if (station.status === status) return `${station.name} was already ${status}. Nothing changed.`;
  await database.query(`UPDATE app.stations SET status = $2 WHERE id = $1`, [station.id, status]);
  return status === 'SUSPENDED'
    ? `${station.name} is now SUSPENDED (it was ${station.status}). Listeners get none of its buttons until it is ACTIVE again.`
    : `${station.name} is now ACTIVE (it was ${station.status}). Listeners get its buttons again.`;
}

export const SETTABLE_CAMPAIGN_STATUSES = ['ACTIVE', 'PAUSED', 'ENDED'] as const;
/** The changes a station could make to a running campaign; a draft is published, and an ended one rescheduled, in the portal. */
const CAMPAIGN_STATUS_CHANGES: Record<string, readonly string[]> = { ACTIVE: ['PAUSED', 'ENDED'], PAUSED: ['ACTIVE', 'ENDED'], DRAFT: [], ENDED: [] };

/**
 * Pauses, resumes or ends the campaign of a station's ad. The database notes when the status changed: a clip heard
 * before then still counts (with the client's usual buttons), one heard after does not.
 */
export async function setCampaignStatus(database: Database, stationName: string, adTitle: string, status: string): Promise<string> {
  if (!(SETTABLE_CAMPAIGN_STATUSES as readonly string[]).includes(status)) {
    throw new WalkthroughToolProblem(`A campaign can be set to ${SETTABLE_CAMPAIGN_STATUSES.join(', ')} here, not "${status}".`);
  }
  const campaign = await findCampaign(database, stationName, adTitle);
  if (campaign.status === status) return `${stationName}'s "${adTitle}" campaign was already ${status}. Nothing changed.`;
  if (!(CAMPAIGN_STATUS_CHANGES[campaign.status] ?? []).includes(status)) {
    const where = campaign.status === 'DRAFT' ? 'publish it in the portal' : 'give the ad new dates in the portal';
    throw new WalkthroughToolProblem(`${stationName}'s "${adTitle}" campaign is ${campaign.status} and cannot be set to ${status} here: ${where}.`);
  }
  try {
    await database.query(`UPDATE app.campaigns SET status = $2 WHERE id = $1`, [campaign.campaignId, status]);
  } catch (error) {
    if ((error as { code?: unknown }).code === '23P01') {
      throw new WalkthroughToolProblem(`"${adTitle}" at ${stationName} already has another live campaign for these dates, so nothing was changed.`);
    }
    throw error;
  }
  const effect: Record<string, string> = {
    PAUSED: "Clips heard from now on get none of its buttons; clips heard before still get the client's usual buttons.",
    ENDED: "Clips heard from now on get none of its buttons; clips heard before still get the client's usual buttons.",
    ACTIVE: 'Listeners get its buttons again while it is on air.',
  };
  return `${stationName}'s "${adTitle}" campaign is now ${status} (it was ${campaign.status}). ${effect[status]}`;
}

const ALL_DAY_EVERY_DAY = [
  { from: '00:00', to: '12:00' },
  { from: '12:00', to: '00:00' },
];

/**
 * Puts back the seed's schedule after a walkthrough changed it in the portal: every day, 00:00 to 12:00 and 12:00
 * to 00:00 (the portal's "all day"), with 10 minutes of grace before and after each slot. The dates and the status
 * stay as they are.
 */
export async function resetSampleSchedule(database: Database, stationName: string, adTitle: string): Promise<string> {
  const campaign = await findCampaign(database, stationName, adTitle);
  await database.query('BEGIN');
  try {
    await database.query(`UPDATE app.campaigns SET time_window_grace_period = interval '10 minutes' WHERE id = $1`, [campaign.campaignId]);
    await database.query(`DELETE FROM app.campaign_time_windows WHERE campaign_id = $1`, [campaign.campaignId]);
    for (const slot of ALL_DAY_EVERY_DAY) {
      await database.query(
        `INSERT INTO app.campaign_time_windows (campaign_id, station_id, days_of_week, local_start_time, local_end_time)
         VALUES ($1, $2, '{1,2,3,4,5,6,7}'::smallint[], $3::time, $4::time)`,
        [campaign.campaignId, campaign.stationId, slot.from, slot.to],
      );
    }
    await database.query('COMMIT');
  } catch (error) {
    await database.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
  return `${stationName}'s "${adTitle}" airs all day, every day again (00:00 to 12:00 and 12:00 to 00:00), with 10 minutes of grace before and after each slot. Its campaign is ${campaign.status}.`;
}

// ---- show-recognitions --------------------------------------------------------------------------------------

/** What show-recognitions reads about one recognition: times, outcome, how it was decided, and names only. */
export interface RecognitionSummary {
  received_at: Date;
  captured_at: Date;
  is_deferred: boolean;
  outcome: string;
  resolution: string | null;
  fallback_reason: string | null;
  station_name: string | null;
  station_frequency_label: string | null;
  station_city: string | null;
  client_name: string | null;
  ad_title: string | null;
  hinted_station_name: string | null;
  shown_stations: Array<{ position: number; name: string; frequency_label: string; city: string | null; card_kind: string; is_chosen: boolean }>;
}

/** The latest recognitions, newest first (of the given installs only, when named: the tests' own). */
export async function readLatestRecognitions(database: Database, options: { count?: number; listenerInstallIds?: readonly string[] } = {}): Promise<RecognitionSummary[]> {
  const result = await database.query(
    `SELECT event.received_at, event.captured_at, event.is_deferred, event.outcome, event.resolution, event.fallback_reason,
            station.name AS station_name, station.frequency_label AS station_frequency_label, station.city AS station_city,
            client.name AS client_name, ad.title AS ad_title, hinted.name AS hinted_station_name,
            coalesce((
              SELECT json_agg(json_build_object('position', candidate.display_position, 'name', shown.name, 'frequency_label', shown.frequency_label,
                                                'city', shown.city, 'card_kind', candidate.card_kind, 'is_chosen', candidate.is_chosen)
                              ORDER BY candidate.display_position)
                FROM app.recognition_candidates AS candidate
                JOIN app.stations AS shown ON shown.id = candidate.station_id
               WHERE candidate.recognition_id = event.id AND candidate.recognition_received_at = event.received_at
                 AND candidate.display_position IS NOT NULL), '[]'::json) AS shown_stations
       FROM app.recognition_events AS event
       LEFT JOIN app.stations AS station ON station.id = event.station_id
       LEFT JOIN app.campaigns AS campaign ON campaign.id = event.campaign_id
       LEFT JOIN app.ads AS ad ON ad.id = campaign.ad_id
       LEFT JOIN app.clients AS client ON client.id = ad.client_id
       LEFT JOIN app.stations AS hinted ON hinted.id = event.hinted_station_id
      WHERE $2::uuid[] IS NULL OR event.listener_install_id = ANY($2::uuid[])
      ORDER BY event.received_at DESC, event.id DESC
      LIMIT $1`,
    [options.count ?? 5, options.listenerInstallIds ? [...options.listenerInstallIds] : null],
  );
  return result.rows as RecognitionSummary[];
}

const stationLabel = (station: { name: string; frequency_label: string; city: string | null }) =>
  `${station.name} (${station.frequency_label}${station.city ? ` · ${station.city}` : ''})`;

const WHY_USUAL_BUTTONS: Record<string, string> = {
  not_on_air: 'the ad was not on air when it was heard',
  campaign_not_active: 'the campaign was paused or ended after it was heard',
  campaign_at_tap_limit: 'the campaign reached its tap limit',
  campaign_has_no_card: 'the campaign has no buttons of its own',
  other_owners_have_no_card: 'other stations that air it have no buttons to show',
};
const WHY_NO_MATCH: Record<string, string> = {
  no_station_airs_it: 'no active station airs this recording',
  no_card_to_show: 'the stations that air it have no buttons to show',
};
const NOT_ANSWERED: Record<string, string> = {
  PENDING: 'Still being identified',
  BUSY: 'Not answered: Look Up was busy (the phone tries again)',
  TIMEOUT: 'Not answered: it took too long (the phone tries again)',
  ERROR: 'Not answered: something went wrong (the API log has the details under the request id)',
  INVALID_AUDIO: 'The recording could not be used',
  AMBIGUOUS: 'No match: the engine could not tell which recording it was',
};

/** One recognition in plain words: when it arrived, when it was heard, and what the listener was shown and why. */
export function describeRecognition(recognition: RecognitionSummary, options: { timeZone: string; now?: Date }): string[] {
  const now = options.now ?? new Date();
  const day = (moment: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: options.timeZone, day: 'numeric', month: 'short' }).format(moment);
  const clock = (moment: Date) => {
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: options.timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(moment);
    return day(moment) === day(now) ? time : `${day(moment)} ${time}`;
  };
  const waitedMinutes = Math.round((recognition.received_at.getTime() - recognition.captured_at.getTime()) / 60_000);
  const sent = recognition.is_deferred
    ? `sent later (${waitedMinutes < 60 ? `${waitedMinutes} min` : `${Math.floor(waitedMinutes / 60)} h ${waitedMinutes % 60} min`} after)`
    : 'sent at once';
  const lines = [`${clock(recognition.received_at)}  heard ${clock(recognition.captured_at)}, ${sent}`];
  const indent = (text: string) => lines.push(`          ${text}`);

  if (recognition.outcome === 'CHOOSE_STATION') {
    const everyUsual = recognition.shown_stations.every((shown) => shown.card_kind === 'CLIENT_DEFAULT');
    indent(`Asked "Which station?"${everyUsual ? ' (none had it on air: each with its usual buttons)' : ''}: ${recognition.shown_stations.map((shown) => `${shown.position}. ${stationLabel(shown)}`).join('  ')}`);
    const chosen = recognition.shown_stations.find((shown) => shown.is_chosen);
    indent(chosen ? `Chosen by the listener: ${chosen.name}` : 'Not chosen yet');
  } else if (recognition.outcome === 'MATCH' || recognition.outcome === 'MATCH_DEFAULT') {
    const buttons =
      recognition.outcome === 'MATCH'
        ? "the campaign's buttons"
        : `${recognition.client_name ?? 'the client'}'s usual buttons${recognition.fallback_reason && WHY_USUAL_BUTTONS[recognition.fallback_reason] ? ` (${WHY_USUAL_BUTTONS[recognition.fallback_reason]})` : ''}`;
    indent(`${recognition.station_name ?? 'A station'} — ${recognition.client_name ?? 'a client'}, "${recognition.ad_title ?? 'an ad'}", ${buttons}`);
    const decidedBy: Record<string, string> = {
      SINGLE_OWNER: 'only one station can answer',
      SCHEDULE_UNIQUE: `the schedule (only ${recognition.station_name ?? 'one station'} had it on air)`,
      HINT: `the listener's "My station" (${recognition.hinted_station_name ?? recognition.station_name ?? 'a station'})`,
    };
    indent(`Decided by: ${decidedBy[recognition.resolution ?? ''] ?? 'not recorded'}`);
  } else if (recognition.outcome === 'NO_MATCH') {
    indent(`No match: ${WHY_NO_MATCH[recognition.fallback_reason ?? ''] ?? 'the recording was not recognised'}`);
  } else {
    indent(NOT_ANSWERED[recognition.outcome] ?? recognition.outcome);
  }
  return lines;
}

/** The latest recognitions in plain words, newest first. */
export async function showRecognitions(database: Database, options: { count?: number; timeZone?: string; listenerInstallIds?: readonly string[] } = {}): Promise<string> {
  const recognitions = await readLatestRecognitions(database, options);
  if (recognitions.length === 0) return 'No recognitions yet.';
  const timeZone = options.timeZone ?? 'Africa/Lusaka';
  return [`The latest ${recognitions.length === 1 ? 'recognition' : `${recognitions.length} recognitions`}, newest first (times in ${timeZone}):`, ...recognitions.flatMap((recognition) => describeRecognition(recognition, { timeZone }))].join('\n');
}

// ---- the command line --------------------------------------------------------------------------------------

const USAGE = [
  'Use one of:',
  '  npm run development:show-recognitions',
  '  npm run development:set-station-status -- "<station>" ACTIVE|SUSPENDED',
  '  npm run development:set-campaign-status -- "<station>" "<ad title>" ACTIVE|PAUSED|ENDED',
  '  npm run development:reset-sample-schedule -- "<station>" "<ad title>"',
].join('\n');

/** Each tool: how many values it takes after its name, and what it does with them. */
const TOOLS: Record<string, { valueCount: number; run: (database: Database, values: readonly string[]) => Promise<string> }> = {
  'show-recognitions': { valueCount: 0, run: (database) => showRecognitions(database) },
  'set-station-status': { valueCount: 2, run: (database, [stationName, status]) => setStationStatus(database, stationName as string, (status as string).toUpperCase()) },
  'set-campaign-status': {
    valueCount: 3,
    run: (database, [stationName, adTitle, status]) => setCampaignStatus(database, stationName as string, adTitle as string, (status as string).toUpperCase()),
  },
  'reset-sample-schedule': { valueCount: 2, run: (database, [stationName, adTitle]) => resetSampleSchedule(database, stationName as string, adTitle as string) },
};

/**
 * Runs one tool by name with its values, on the setup database, and resolves to what to print. The guard and the
 * arguments are checked before any connection is made.
 */
export async function runWalkthroughTool(toolArguments: readonly string[], environment: { setupUrl: string | undefined; nodeEnvironment: string | undefined }): Promise<string> {
  assertDevelopmentDatabase(environment.setupUrl, environment.nodeEnvironment);
  const [toolName, ...values] = toolArguments;
  const tool = toolName === undefined ? undefined : TOOLS[toolName];
  if (!tool || values.length !== tool.valueCount) throw new WalkthroughToolProblem(USAGE);
  const database = new pg.Client({ connectionString: environment.setupUrl, application_name: 'lookup-development-walkthrough-tools' });
  await database.connect();
  try {
    return await tool.run(database, values);
  } finally {
    await database.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let setupUrl: string | undefined;
  try {
    setupUrl = loadDatabaseSetupConfig().setupUrl;
  } catch {
    setupUrl = undefined;
  }
  runWalkthroughTool(process.argv.slice(2), { setupUrl, nodeEnvironment: process.env.NODE_ENV })
    .then((output) => console.log(output))
    .catch((error: unknown) => {
      // Our own refusals are written for people; anything else is summed up by its code alone, as its text can hold values.
      const code = typeof (error as { code?: unknown }).code === 'string' ? ` (${(error as { code: string }).code})` : '';
      console.error(error instanceof WalkthroughToolProblem ? error.message : `The tool failed${code}. Is Docker running, and is the database migrated (npm run database:migrate)?`);
      process.exit(1);
    });
}
