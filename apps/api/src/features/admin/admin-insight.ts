import {
  type AudioOverlapFinding,
  type AudioOverlapList,
  type AudioOverlapPreviewLinks,
  type AudioOverlapSide,
  HEALTH_QUEUE_NAMES,
  INGEST_QUEUE_NAME,
  type PrivateFileLink,
  readReferenceCodeQuery,
  RECOGNIZE_QUEUE_NAME,
  type ReferenceCodeSearchResult,
  type SystemHealth,
} from '@lookup/contracts';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { AppError } from '../../common/errors/app-error.js';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { AdminTransaction } from '../../infrastructure/admin-database/admin-database.module.js';
import { workerHeartbeatKey } from '../../infrastructure/job-queues/worker-heartbeat-key.js';
import { ObjectStorage } from '../../infrastructure/object-storage/object-storage.js';
import { NOTIFY_QUEUE_NAME } from '../notifications/notification-queue.js';

/** An A/B preview plays for 5 minutes. */
const PREVIEW_LINK_SECONDS = 5 * 60;
const HEALTH_PERIOD_HOURS = 24;
const REFERENCE_CODE_RESULT_LIMIT = 20;

interface OverlapRow {
  finding_id: string;
  audio_asset_number: number;
  overlapping_audio_asset_number: number;
  overlap_milliseconds: number;
  found_at: Date;
  reviewed_at: Date | null;
  review_note: string | null;
  audio_asset_ads: Array<{ ad_id: string; ad_title: string; station_id: string; station_name: string | null }>;
  overlapping_audio_asset_ads: Array<{ ad_id: string; ad_title: string; station_id: string; station_name: string | null }>;
}

/**
 * What the console shows besides applications and stations (P5A design §3.3, §4.6): the audio findings to check
 * (only through the two database functions, P5A-D11), System health and "Find by reference code" (gap 14, P5A-D20).
 */
@Injectable()
export class AdminInsight implements OnApplicationShutdown {
  private readonly connection: Redis;
  private readonly queues: Map<string, Queue>;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly adminTransaction: AdminTransaction,
    private readonly objectStorage: ObjectStorage,
  ) {
    this.connection = new Redis(config.KEY_VALUE_STORE_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 3_000, lazyConnect: true });
    this.connection.on('error', () => undefined);
    const names: Record<(typeof HEALTH_QUEUE_NAMES)[number], string> = { recognize: RECOGNIZE_QUEUE_NAME, ingest: INGEST_QUEUE_NAME, notify: NOTIFY_QUEUE_NAME };
    this.queues = new Map(HEALTH_QUEUE_NAMES.map((name) => [name, new Queue(names[name], { connection: this.connection, prefix: config.QUEUE_KEY_PREFIX })]));
  }

  async onApplicationShutdown(): Promise<void> {
    for (const queue of this.queues.values()) await queue.close().catch(() => undefined);
    await this.connection.quit().catch(() => this.connection.disconnect());
  }

  async listAudioOverlaps(): Promise<AudioOverlapList> {
    const rows = (await this.adminTransaction.run((database) => database.query('SELECT * FROM app.list_asset_overlaps_for_review()'))) as OverlapRow[];
    return { findings: rows.map(toFinding) };
  }

  /** Plays the upload of an ad that uses each recording (P5A design fact 7: the assets keep no audio of their own). */
  async createOverlapPreviewLinks(findingId: string): Promise<AudioOverlapPreviewLinks> {
    const finding = await this.findOverlap(findingId);
    const linkFor = async (adId: string | undefined): Promise<PrivateFileLink | null> => {
      if (!adId) return null;
      const [ad] = (await this.adminTransaction.run((database) =>
        database.query('SELECT upload_object_key, upload_content_type, title FROM app.ads WHERE id = $1', [adId]),
      )) as Array<{ upload_object_key: string | null; upload_content_type: string | null; title: string }>;
      if (!ad?.upload_object_key || !ad.upload_content_type) return null;
      const address = await this.objectStorage.createDownloadUrlIn(this.objectStorage.adUploadsBucket, ad.upload_object_key, PREVIEW_LINK_SECONDS, {
        contentType: ad.upload_content_type,
        fileName: ad.title,
      });
      return { address, contentType: ad.upload_content_type, expiresAt: new Date(Date.now() + PREVIEW_LINK_SECONDS * 1000).toISOString() };
    };
    return { first: await linkFor(finding.audio_asset_ads[0]?.ad_id), second: await linkFor(finding.overlapping_audio_asset_ads[0]?.ad_id) };
  }

  async reviewAudioOverlap(findingId: string, note: string | null, requestId: string): Promise<void> {
    const [result] = (await this.adminTransaction.run((database) =>
      database.query('SELECT app.record_asset_overlap_review($1, $2, $3) AS outcome', [findingId, note, requestId]),
    )) as Array<{ outcome: string }>;
    if (result?.outcome === 'NOT_FOUND') throw new AppError('NOT_FOUND', { internalDetail: 'no such finding' });
    if (result?.outcome === 'ALREADY_REVIEWED') throw new AppError('CONFLICT', { internalDetail: 'finding already reviewed' });
    if (result?.outcome !== 'REVIEWED') throw new AppError('FORBIDDEN', { internalDetail: `overlap review refused: ${result?.outcome}` });
  }

  /** The last 24 hours (P5A design §4.6): queue depths, whether each worker is alive, recognitions, p95 and errors. */
  async readSystemHealth(): Promise<SystemHealth> {
    const queues = await Promise.all(
      HEALTH_QUEUE_NAMES.map(async (name) => {
        const counts = await (this.queues.get(name) as Queue).getJobCounts('waiting', 'prioritized', 'active', 'delayed').catch(() => null);
        return { name, depth: counts ? Object.values(counts).reduce((total, count) => total + count, 0) : 0 };
      }),
    );
    const workers = await Promise.all(
      HEALTH_QUEUE_NAMES.map(async (name) => ({
        name,
        isRunning: (await this.connection.exists(workerHeartbeatKey(this.config.QUEUE_KEY_PREFIX, name)).catch(() => 0)) === 1,
      })),
    );
    const [traffic] = (await this.adminTransaction.run((database) =>
      database.query(
        `SELECT count(*)::integer AS recognition_count,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_milliseconds)
                  FILTER (WHERE outcome IN ('MATCH', 'MATCH_DEFAULT', 'CHOOSE_STATION', 'NO_MATCH')) AS match_milliseconds_at_95th_percentile,
                count(*) FILTER (WHERE outcome IN ('TIMEOUT', 'BUSY', 'ERROR'))::integer AS failed_count,
                count(*) FILTER (WHERE outcome <> 'PENDING')::integer AS finished_count
           FROM app.recognition_events WHERE received_at > now() - make_interval(hours => $1)`,
        [HEALTH_PERIOD_HOURS],
      ),
    )) as Array<{ recognition_count: number; match_milliseconds_at_95th_percentile: number | null; failed_count: number; finished_count: number }>;
    return {
      measuredAt: new Date().toISOString(),
      periodHours: HEALTH_PERIOD_HOURS,
      queues,
      workers,
      recognitionCount: traffic?.recognition_count ?? 0,
      matchMillisecondsAt95thPercentile: traffic?.match_milliseconds_at_95th_percentile === null || traffic === undefined ? null : Math.round(traffic.match_milliseconds_at_95th_percentile),
      errorRate: traffic && traffic.finished_count > 0 ? traffic.failed_count / traffic.finished_count : null,
    };
  }

  /** Recognitions and audit events whose request id starts with the code a person quoted (gap 14, P5A-D20). */
  async findByReferenceCode(typed: string): Promise<ReferenceCodeSearchResult> {
    const query = readReferenceCodeQuery(typed);
    if (!query) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'code', code: 'not_a_reference_code' }], internalDetail: 'not a reference code' });
    const pattern = query.kind === 'prefix' ? `${query.prefix}%` : query.requestId;
    return this.adminTransaction.run(async (database) => {
      const recognitions = (await database.query(
        `SELECT event.request_id, event.received_at, event.outcome, station.name AS station_name
           FROM app.recognition_events AS event LEFT JOIN app.stations AS station ON station.id = event.station_id
          WHERE event.request_id LIKE $1 ORDER BY event.received_at DESC LIMIT ${REFERENCE_CODE_RESULT_LIMIT}`,
        [pattern],
      )) as Array<{ request_id: string; received_at: Date; outcome: string; station_name: string | null }>;
      const auditEvents = (await database.query(
        `SELECT event.request_id, event.occurred_at, event.action, event.entity_type, actor.full_name AS actor_name, station.name AS station_name
           FROM app.audit_events AS event
           LEFT JOIN app.portal_users AS actor ON actor.id = event.actor_portal_user_id
           LEFT JOIN app.stations AS station ON station.id = event.station_id
          WHERE event.request_id LIKE $1 ORDER BY event.occurred_at DESC LIMIT ${REFERENCE_CODE_RESULT_LIMIT}`,
        [pattern],
      )) as Array<{ request_id: string; occurred_at: Date; action: string; entity_type: string; actor_name: string | null; station_name: string | null }>;
      return {
        searchedFor: query.kind === 'prefix' ? query.prefix : query.requestId,
        recognitions: recognitions.map((row) => ({ requestId: row.request_id, receivedAt: row.received_at.toISOString(), outcome: row.outcome, stationName: row.station_name })),
        auditEvents: auditEvents.map((row) => ({
          requestId: row.request_id,
          occurredAt: row.occurred_at.toISOString(),
          action: row.action,
          entityType: row.entity_type,
          actorName: row.actor_name,
          stationName: row.station_name,
        })),
      };
    });
  }

  private async findOverlap(findingId: string): Promise<OverlapRow> {
    const rows = (await this.adminTransaction.run((database) =>
      database.query('SELECT * FROM app.list_asset_overlaps_for_review() WHERE finding_id = $1', [findingId]),
    )) as OverlapRow[];
    if (!rows[0]) throw new AppError('NOT_FOUND', { internalDetail: 'no such finding' });
    return rows[0];
  }
}

function toSide(assetNumber: number, ads: OverlapRow['audio_asset_ads']): AudioOverlapSide {
  return { audioAssetNumber: assetNumber, ads: ads.map((ad) => ({ adId: ad.ad_id, adTitle: ad.ad_title, stationId: ad.station_id, stationName: ad.station_name })) };
}

function toFinding(row: OverlapRow): AudioOverlapFinding {
  return {
    id: row.finding_id,
    overlapMilliseconds: row.overlap_milliseconds,
    foundAt: row.found_at.toISOString(),
    reviewedAt: row.reviewed_at?.toISOString() ?? null,
    reviewNote: row.review_note,
    first: toSide(row.audio_asset_number, row.audio_asset_ads),
    second: toSide(row.overlapping_audio_asset_number, row.overlapping_audio_asset_ads),
  };
}
