import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { safeActionCard } from './listener-test-kit.js';

export type ActionCardContent = ReturnType<typeof safeActionCard>;

export interface TimeWindowSpecification {
  days: number[];
  from: string;
  to: string;
}

/** Every day, all day, as the portal saves "all day": 00:00 to 12:00 and 12:00 to 00:00. */
export const ALL_DAY_EVERY_DAY: TimeWindowSpecification[] = [
  { days: [1, 2, 3, 4, 5, 6, 7], from: '00:00', to: '12:00' },
  { days: [1, 2, 3, 4, 5, 6, 7], from: '12:00', to: '00:00' },
];

export interface Recording {
  assetId: string;
  assetNumber: number;
}

/** One campaign of one station on a recording, with the cards a listener could be shown. */
export interface StationAiring {
  stationId: string;
  clientId: string;
  adId: string;
  campaignId: string;
  campaignCardId: string | null;
  campaignCard: ActionCardContent | null;
  defaultCardId: string | null;
  defaultCard: ActionCardContent | null;
}

export interface Claimed {
  recognition_id: string;
  recognition_received_at: Date;
  recognition_captured_at: Date;
  attempt_number: number;
  claim_outcome: string;
  previous_outcome: string | null;
  is_deferred: boolean;
}

export interface WeighedCandidate {
  station_id: string;
  campaign_id: string;
  action_card_id: string;
  card_kind: 'CAMPAIGN' | 'CLIENT_DEFAULT';
  is_in_window: boolean;
  display_position: number | null;
}

/**
 * A UUID version 7 whose time is the given moment, as the API makes a recognition's id when the clip has been
 * read: the database finds a recognition by its id between bounds read from that time.
 */
export function recognitionIdAt(milliseconds: number): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(milliseconds, 0, 6);
  bytes[6] = 0x70 | ((bytes[6] as number) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] as number) & 0x3f);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Stations, recordings, ads, campaigns, installs and recognitions for the phase 4 database tests, written
 * straight into the database as the setup user and removed afterwards, with what phase 4 stores about them
 * (candidates, taps, counters, reports) removed first.
 */
export class StationResolutionTestData {
  private readonly stationIds: string[] = [];
  private readonly assetIds: string[] = [];
  private readonly installIds: string[] = [];
  private nextPhoneNumber = 1;

  constructor(private readonly setupClient: pg.Client) {}

  async createRecording(): Promise<Recording> {
    const assetId = randomUUID();
    this.assetIds.push(assetId);
    const row = await this.setupClient.query(
      `INSERT INTO fingerprints.audio_assets (id, content_sha256, duration_milliseconds, fingerprint_version, hash_count)
       VALUES ($1, $2, 30000, 1, 500) RETURNING asset_number`,
      [assetId, randomBytes(32)],
    );
    return { assetId, assetNumber: row.rows[0].asset_number as number };
  }

  async createStation(
    options: { name?: string; frequencyLabel?: string; status?: string; timeZone?: string; city?: string | null; isListedInApp?: boolean } = {},
  ): Promise<string> {
    const stationId = randomUUID();
    this.stationIds.push(stationId);
    await this.setupClient.query(
      `INSERT INTO app.stations (id, name, frequency_label, status, time_zone, city, is_listed_in_app) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        stationId,
        options.name ?? `Resolution test ${stationId.slice(0, 8)}`,
        options.frequencyLabel ?? '98.1 FM',
        options.status ?? 'ACTIVE',
        options.timeZone ?? 'Africa/Lusaka',
        options.city === undefined ? 'Lusaka' : options.city,
        options.isListedInApp ?? true,
      ],
    );
    return stationId;
  }

  async createClient(stationId: string, name = 'Brand A'): Promise<string> {
    const clientId = randomUUID();
    await this.setupClient.query(`INSERT INTO app.clients (id, station_id, name) VALUES ($1, $2, $3)`, [clientId, stationId, name]);
    return clientId;
  }

  async createCard(stationId: string, clientId: string): Promise<{ cardId: string; content: ActionCardContent }> {
    const cardId = randomUUID();
    const content = safeActionCard({ firstNumber: this.nextPhoneNumber });
    this.nextPhoneNumber = (this.nextPhoneNumber % 997) + 2;
    await this.setupClient.query(`INSERT INTO app.action_cards (id, station_id, client_id, schema_version, content) VALUES ($1, $2, $3, 1, $4)`, [
      cardId,
      stationId,
      clientId,
      content,
    ]);
    return { cardId, content };
  }

  /**
   * A station airing an ad on the recording: by default a new ACTIVE station in Lusaka with a client, the
   * campaign's own card, an ACTIVE campaign from a week ago to a week ahead, on air all day every day, with the
   * column's default grace. A campaign created PAUSED or ENDED has its status changed now.
   */
  async airAd(options: {
    recording: Recording;
    stationId?: string;
    station?: Parameters<StationResolutionTestData['createStation']>[0];
    clientId?: string;
    clientName?: string;
    title?: string;
    campaignStatus?: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ENDED';
    period?: [string, string];
    windows?: TimeWindowSpecification[];
    gracePeriodMinutes?: number;
    engagementLimit?: number | null;
    hasCampaignCard?: boolean;
    hasDefaultCard?: boolean;
    isAdArchived?: boolean;
  }): Promise<StationAiring> {
    const stationId = options.stationId ?? (await this.createStation(options.station));
    const clientId = options.clientId ?? (await this.createClient(stationId, options.clientName));
    const campaignCard = options.hasCampaignCard === false ? null : await this.createCard(stationId, clientId);
    let defaultCard = null as { cardId: string; content: ActionCardContent } | null;
    if (options.hasDefaultCard) {
      defaultCard = await this.createCard(stationId, clientId);
      await this.setupClient.query('UPDATE app.clients SET default_action_card_id = $2 WHERE id = $1', [clientId, defaultCard.cardId]);
    } else if (options.clientId) {
      const existing = await this.setupClient.query(
        `SELECT client.default_action_card_id, card.content FROM app.clients AS client
           LEFT JOIN app.action_cards AS card ON card.id = client.default_action_card_id WHERE client.id = $1`,
        [clientId],
      );
      if (existing.rows[0]?.default_action_card_id) defaultCard = { cardId: existing.rows[0].default_action_card_id, content: existing.rows[0].content };
    }
    const adId = randomUUID();
    await this.setupClient.query(
      `INSERT INTO app.ads (id, station_id, client_id, title, status, audio_asset_id, current_action_card_id, archived_at)
       VALUES ($1, $2, $3, $4, 'READY', $5, $6, CASE WHEN $7 THEN now() END)`,
      [adId, stationId, clientId, options.title ?? 'Summer service offer', options.recording.assetId, campaignCard?.cardId ?? null, options.isAdArchived ?? false],
    );
    const [startsAt, endsAt] = options.period ?? [new Date(Date.now() - 7 * 86_400_000).toISOString(), new Date(Date.now() + 7 * 86_400_000).toISOString()];
    const campaignId = randomUUID();
    await this.setupClient.query(
      `INSERT INTO app.campaigns (id, station_id, ad_id, action_card_id, name, status, active_period, engagement_limit, time_window_grace_period)
       VALUES ($1, $2, $3, $4, 'Campaign', $5, tstzrange($6::timestamptz, $7::timestamptz), $8,
               coalesce(make_interval(mins => $9::integer), interval '10 minutes'))`,
      [campaignId, stationId, adId, campaignCard?.cardId ?? null, options.campaignStatus ?? 'ACTIVE', startsAt, endsAt, options.engagementLimit ?? null,
        options.gracePeriodMinutes ?? null],
    );
    for (const window of options.windows ?? ALL_DAY_EVERY_DAY) {
      await this.setupClient.query(
        `INSERT INTO app.campaign_time_windows (campaign_id, station_id, days_of_week, local_start_time, local_end_time) VALUES ($1, $2, $3, $4, $5)`,
        [campaignId, stationId, window.days, window.from, window.to],
      );
    }
    return {
      stationId,
      clientId,
      adId,
      campaignId,
      campaignCardId: campaignCard?.cardId ?? null,
      campaignCard: campaignCard?.content ?? null,
      defaultCardId: defaultCard?.cardId ?? null,
      defaultCard: defaultCard?.content ?? null,
    };
  }

  async createInstall(): Promise<string> {
    const installId = randomUUID();
    this.installIds.push(installId);
    await this.setupClient.query(`INSERT INTO app.listener_installs (id, install_id_hash, platform, app_version) VALUES ($1, $2, 'ANDROID', '1.0.0')`, [
      installId,
      randomBytes(32),
    ]);
    return installId;
  }

  /** Claims a key as the API does, through recognition.claim_recognition as the API role. */
  async claim(
    apiClient: pg.Client,
    installId: string,
    options: { key?: string; receivedAt?: Date; capturedAt?: Date; isDeferred?: boolean; clockSkewMilliseconds?: number } = {},
  ): Promise<Claimed> {
    const receivedAt = options.receivedAt ?? new Date();
    const capturedAt = options.capturedAt ?? new Date(receivedAt.getTime() - 9_000);
    const result = await apiClient.query('SELECT * FROM recognition.claim_recognition($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', [
      installId,
      options.key ?? randomUUID(),
      recognitionIdAt(receivedAt.getTime()),
      `request-${randomUUID()}`,
      capturedAt,
      capturedAt,
      options.clockSkewMilliseconds ?? 0,
      receivedAt,
      options.isDeferred ?? false,
      8000,
    ]);
    return result.rows[0] as Claimed;
  }

  /** Finishes an attempt through recognition.finish_recognition as the API role; resolves to whether it was recorded. */
  async finish(
    apiClient: pg.Client,
    claimed: Pick<Claimed, 'recognition_id' | 'recognition_received_at' | 'attempt_number'>,
    finished: {
      outcome: string;
      resolution?: string | null;
      recording?: Recording;
      shown?: { stationId: string; campaignId: string; cardId: string } | null;
      hintedStationId?: string | null;
      candidates?: WeighedCandidate[];
      fallbackReason?: string | null;
    },
  ): Promise<boolean> {
    const result = await apiClient.query(
      `SELECT recognition.finish_recognition($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, 40, 3.5, 6000, 300, 1::smallint) AS is_recorded`,
      [
        claimed.recognition_id,
        claimed.recognition_received_at,
        claimed.attempt_number,
        finished.outcome,
        finished.fallbackReason ?? null,
        finished.recording?.assetNumber ?? null,
        finished.shown?.stationId ?? null,
        finished.shown?.campaignId ?? null,
        finished.shown?.cardId ?? null,
        finished.resolution ?? null,
        finished.hintedStationId ?? null,
        JSON.stringify(finished.candidates ?? []),
      ],
    );
    return result.rows[0].is_recorded as boolean;
  }

  /** The candidate row a station weighed with its campaign card (or, with `kind`, its client's default card) would get. */
  static candidate(airing: StationAiring, options: { kind?: 'CAMPAIGN' | 'CLIENT_DEFAULT'; isInWindow?: boolean; displayPosition?: number | null } = {}): WeighedCandidate {
    const kind = options.kind ?? 'CAMPAIGN';
    const cardId = kind === 'CAMPAIGN' ? airing.campaignCardId : airing.defaultCardId;
    if (!cardId) throw new Error(`the airing has no ${kind} card`);
    return {
      station_id: airing.stationId,
      campaign_id: airing.campaignId,
      action_card_id: cardId,
      card_kind: kind,
      is_in_window: options.isInWindow ?? true,
      display_position: options.displayPosition ?? null,
    };
  }

  async removeAll(): Promise<void> {
    const query = (sql: string, values: unknown[]) => this.setupClient.query(sql, values);
    const stations = this.stationIds;
    const installs = this.installIds;
    await query(
      `DELETE FROM app.engagement_deduplication_keys WHERE recognition_id IN (
         SELECT id FROM app.recognition_events WHERE listener_install_id = ANY($1) OR station_id = ANY($2))`,
      [installs, stations],
    );
    await query('DELETE FROM app.engagement_events WHERE station_id = ANY($1)', [stations]);
    await query('DELETE FROM app.recognition_reports WHERE station_id = ANY($1)', [stations]);
    await query('DELETE FROM app.campaign_counters WHERE station_id = ANY($1)', [stations]);
    await query(
      `DELETE FROM app.recognition_candidates WHERE station_id = ANY($2) OR recognition_id IN (
         SELECT id FROM app.recognition_events WHERE listener_install_id = ANY($1))`,
      [installs, stations],
    );
    await query('DELETE FROM app.recognition_idempotency_keys WHERE listener_install_id = ANY($1)', [installs]);
    await query('DELETE FROM app.recognition_events WHERE listener_install_id = ANY($1) OR station_id = ANY($2) OR hinted_station_id = ANY($2)', [
      installs,
      stations,
    ]);
    await query('DELETE FROM app.listener_installs WHERE id = ANY($1)', [installs]);
    await query('DELETE FROM app.campaign_time_windows WHERE station_id = ANY($1)', [stations]);
    await query('DELETE FROM app.campaigns WHERE station_id = ANY($1)', [stations]);
    await query('DELETE FROM app.ads WHERE station_id = ANY($1)', [stations]);
    await query('UPDATE app.clients SET default_action_card_id = NULL WHERE station_id = ANY($1)', [stations]);
    await query('DELETE FROM app.action_cards WHERE station_id = ANY($1)', [stations]);
    await query('DELETE FROM app.clients WHERE station_id = ANY($1)', [stations]);
    await query('DELETE FROM app.audit_events WHERE station_id = ANY($1)', [stations]);
    await query('DELETE FROM app.stations WHERE id = ANY($1)', [stations]);
    await query('DELETE FROM fingerprints.audio_assets WHERE id = ANY($1)', [this.assetIds]);
  }
}
