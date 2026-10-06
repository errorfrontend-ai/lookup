import { randomUUID } from 'node:crypto';
import {
  ADS_PER_PAGE,
  type AdDetail,
  type AdListPage,
  type AdListQuery,
  type AdPlaybackUrl,
  type AdStatus,
  type AdUploadContentType,
  type CampaignDisplayStatus,
  type CreateAdInput,
  type CreatedAd,
  type RenameAdInput,
  type RequestUploadUrlInput,
  type UploadInstructions,
  type UploadRefusalReason,
  type UploadRequest,
} from '@lookup/contracts';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { EntityManager } from 'typeorm';
import { AuditTrail } from '../../common/audit/audit-trail.js';
import { AppError } from '../../common/errors/app-error.js';
import { StationScopedTransaction } from '../../infrastructure/database/station-scoped-transaction.js';
import { ObjectStorage } from '../../infrastructure/object-storage/object-storage.js';
import { type AdListRow, buildAdListQuery, nextAdListCursor } from './ad-list-query.js';
import { type AdRecord, findAdRecord, toAdDetail, toAdSummary } from './ad-records.js';
import { AUDIO_SIGNATURE_BYTES_TO_READ, isDeclaredAudioFormat } from './audio-file-signatures.js';

/** Upload URLs live 10 minutes: expiry is checked when the upload starts, so a slow link still finishes. */
const UPLOAD_URL_LIFETIME_SECONDS = 600;
const PLAYBACK_URL_LIFETIME_SECONDS = 300;
/** Statuses in which the uploaded file has been verified and may be played back. */
/** A campaign in any of these is published: listeners can get its buttons now or later. */
const PUBLISHED_DISPLAY_STATUSES: readonly CampaignDisplayStatus[] = ['SCHEDULED', 'LIVE_NOW', 'PAUSED'];

const VERIFIED_UPLOAD_STATUSES: readonly AdStatus[] = ['PROCESSING', 'READY', 'NEEDS_REVIEW'];



/**
 * Ads and their audio uploads. The browser uploads straight to object storage through a presigned URL
 * (the API never handles the bytes); `complete` then checks what actually arrived — exact size and
 * type, and the first bytes — before the ad moves on to processing. Object keys are made by the
 * server; a file name the station chose is kept only for display.
 */
@Injectable()
export class AdsService {
  constructor(
    private readonly stationScopedTransaction: StationScopedTransaction,
    private readonly objectStorage: ObjectStorage,
    private readonly auditTrail: AuditTrail,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('ads');
  }

  async create(input: CreateAdInput): Promise<CreatedAd> {
    const adId = randomUUID();
    const prepared = await this.stationScopedTransaction.run(async (database) => {
      const [client] = (await database.query(`SELECT id FROM app.clients WHERE id = $1`, [input.clientId])) as Array<{ id: string }>;
      if (!client) {
        throw new AppError('VALIDATION_FAILED', {
          fields: [{ path: 'clientId', code: 'unknown_client' }],
          internalDetail: 'client not found at this station',
        });
      }
      const upload = await this.prepareUploadAttempt(database, adId, input.upload);
      await database.query(
        `INSERT INTO app.ads (id, station_id, client_id, title, upload_object_key, upload_content_type, upload_size_bytes,
                              upload_original_file_name, upload_expires_at)
         VALUES ($1, app.current_station_id(), $2, $3, $4, $5, $6, $7, $8)`,
        [adId, input.clientId, input.title, upload.objectKey, input.upload.contentType, input.upload.sizeBytes, upload.displayFileName, upload.expiresAt],
      );
      await this.auditTrail.record(database, {
        action: 'ad_created',
        entityType: 'ad',
        entityId: adId,
        changes: { title: input.title, clientId: input.clientId, upload: describeUpload(input.upload, upload.displayFileName) },
      });
      return upload;
    });
    return { adId, upload: await this.buildUploadInstructions(prepared.objectKey, input.upload, prepared.expiresAt) };
  }

  /** Changes the ad's title (what stations see in lists and listeners see above the buttons). Naming it what it is already called changes and records nothing. */
  rename(adId: string, input: RenameAdInput): Promise<AdDetail> {
    return this.stationScopedTransaction.run(async (database) => {
      const ad = await this.findAdForUpdate(database, adId);
      if (ad.title !== input.title) {
        await database.query(`UPDATE app.ads SET title = $2 WHERE id = $1`, [adId, input.title]);
        await this.auditTrail.record(database, {
          action: 'ad_renamed',
          entityType: 'ad',
          entityId: adId,
          changes: { previousTitle: ad.title, title: input.title },
        });
      }
      return toAdDetail(await findAdRecord(database, adId));
    });
  }

  /**
   * Removes an ad from the station's lists. It is kept (marked archived, never deleted), so its history
   * and any counts stay intact. An ad that is published can't be removed until its schedule has ended,
   * so an ad listeners can hear never disappears from under them.
   */
  async archive(adId: string): Promise<void> {
    await this.stationScopedTransaction.run(async (database) => {
      const ad = await this.findAdForUpdate(database, adId);
      if (ad.campaign_display_status && PUBLISHED_DISPLAY_STATUSES.includes(ad.campaign_display_status)) {
        throw new AppError('CONFLICT', {
          publicMessage: 'This ad is published. It can be removed once its schedule has ended.',
          internalDetail: `archive refused while ${ad.campaign_display_status}`,
        });
      }
      await database.query(`UPDATE app.ads SET archived_at = now() WHERE id = $1`, [adId]);
      await this.auditTrail.record(database, { action: 'ad_archived', entityType: 'ad', entityId: adId, changes: { title: ad.title } });
    });
  }

  /** A fresh upload URL: to retry an upload that didn't finish, or to replace a file that was refused. */
  async requestUploadUrl(adId: string, input: RequestUploadUrlInput): Promise<UploadInstructions> {
    const { prepared, previousObjectKey } = await this.stationScopedTransaction.run(async (database) => {
      const ad = await this.findAdForUpdate(database, adId);
      if (ad.status !== 'AWAITING_UPLOAD' && ad.status !== 'FAILED') {
        throw new AppError('CONFLICT', {
          publicMessage: "This ad's audio has already been uploaded and checked.",
          internalDetail: `upload url requested in status ${ad.status}`,
        });
      }
      const upload = await this.prepareUploadAttempt(database, adId, input.upload);
      await database.query(
        `UPDATE app.ads
            SET upload_object_key = $2, upload_content_type = $3, upload_size_bytes = $4, upload_original_file_name = $5,
                upload_expires_at = $6, upload_entity_tag = NULL, uploaded_at = NULL, processing_error_code = NULL,
                status = 'AWAITING_UPLOAD'
          WHERE id = $1`,
        [adId, upload.objectKey, input.upload.contentType, input.upload.sizeBytes, upload.displayFileName, upload.expiresAt],
      );
      await this.auditTrail.record(database, {
        action: 'ad_upload_restarted',
        entityType: 'ad',
        entityId: adId,
        changes: { upload: describeUpload(input.upload, upload.displayFileName) },
      });
      return { prepared: upload, previousObjectKey: ad.upload_object_key };
    });
    if (previousObjectKey) await this.deleteObjectQuietly(previousObjectKey);
    return this.buildUploadInstructions(prepared.objectKey, input.upload, prepared.expiresAt);
  }

  /**
   * Checks what arrived in storage and moves the ad to PROCESSING. Safe to repeat: an ad whose upload
   * was already accepted is simply returned. A wrong file is deleted and the ad marked FAILED with the
   * reason, so the station can upload again.
   */
  async completeUpload(adId: string): Promise<AdDetail> {
    const ad = await this.stationScopedTransaction.run((database) => findAdRecord(database, adId));
    if (VERIFIED_UPLOAD_STATUSES.includes(ad.status)) return toAdDetail(ad);
    if (ad.status === 'FAILED') {
      throw new AppError('CONFLICT', {
        publicMessage: 'This upload was refused. Please upload the file again.',
        internalDetail: 'complete called on a FAILED ad',
      });
    }
    const objectKey = ad.upload_object_key as string;
    const declaredType = ad.upload_content_type as AdUploadContentType;

    const storedFacts = await this.objectStorage.describeObject(objectKey);
    if (!storedFacts) throw new AppError('UPLOAD_NOT_RECEIVED', { internalDetail: 'no object at the upload key' });
    if (storedFacts.sizeBytes !== ad.upload_size_bytes || storedFacts.contentType !== declaredType) {
      return this.refuseUpload(adId, objectKey, 'size_or_type_mismatch');
    }
    const firstBytes = await this.objectStorage.readFirstBytes(objectKey, storedFacts.entityTag, AUDIO_SIGNATURE_BYTES_TO_READ);
    if (!isDeclaredAudioFormat(firstBytes, declaredType)) return this.refuseUpload(adId, objectKey, 'not_the_declared_audio_format');

    return this.stationScopedTransaction.run(async (database) => {
      const accepted = (await database.query(
        `UPDATE app.ads SET status = 'PROCESSING', upload_entity_tag = $3, uploaded_at = now()
          WHERE id = $1 AND status = 'AWAITING_UPLOAD' AND upload_object_key = $2
          RETURNING id`,
        [adId, objectKey, storedFacts.entityTag],
      )) as unknown[];
      if (accepted.length > 0) {
        await this.auditTrail.record(database, {
          action: 'ad_upload_verified',
          entityType: 'ad',
          entityId: adId,
          changes: { sizeBytes: storedFacts.sizeBytes, contentType: declaredType },
        });
      }
      return toAdDetail(await findAdRecord(database, adId));
    });
  }

  async list(query: AdListQuery): Promise<AdListPage> {
    const { sql, parameters } = buildAdListQuery(query);
    const rows = (await this.stationScopedTransaction.run((database) => database.query(sql, parameters))) as AdListRow[];
    return {
      ads: rows.slice(0, ADS_PER_PAGE).map(toAdSummary),
      nextCursor: nextAdListCursor(query.sort, rows),
    };
  }

  get(adId: string): Promise<AdDetail> {
    return this.stationScopedTransaction.run(async (database) => toAdDetail(await findAdRecord(database, adId)));
  }

  async playbackUrl(adId: string): Promise<AdPlaybackUrl> {
    const ad = await this.stationScopedTransaction.run((database) => findAdRecord(database, adId));
    if (!VERIFIED_UPLOAD_STATUSES.includes(ad.status) || !ad.upload_object_key) {
      throw new AppError('CONFLICT', {
        publicMessage: "This ad's audio hasn't been uploaded yet.",
        internalDetail: `playback requested in status ${ad.status}`,
      });
    }
    return {
      url: await this.objectStorage.createPlaybackUrl(ad.upload_object_key, PLAYBACK_URL_LIFETIME_SECONDS),
      expiresAt: new Date(Date.now() + PLAYBACK_URL_LIFETIME_SECONDS * 1000).toISOString(),
    };
  }

  private async refuseUpload(adId: string, objectKey: string, reason: UploadRefusalReason): Promise<never> {
    await this.deleteObjectQuietly(objectKey);
    await this.stationScopedTransaction.run(async (database) => {
      const refused = (await database.query(
        `UPDATE app.ads SET status = 'FAILED', processing_error_code = $3
          WHERE id = $1 AND status = 'AWAITING_UPLOAD' AND upload_object_key = $2 RETURNING id`,
        [adId, objectKey, reason],
      )) as unknown[];
      if (refused.length > 0) {
        await this.auditTrail.record(database, { action: 'ad_upload_refused', entityType: 'ad', entityId: adId, changes: { reason } });
      }
    });
    throw new AppError('UPLOAD_REJECTED', { internalDetail: `upload refused: ${reason}` });
  }


  private async findAdForUpdate(database: EntityManager, adId: string): Promise<AdRecord> {
    await database.query(`SELECT id FROM app.ads WHERE id = $1 FOR UPDATE`, [adId]);
    return findAdRecord(database, adId);
  }

  /** Server-made object key; the station's file name is kept only, cleaned, for display. */
  private async prepareUploadAttempt(database: EntityManager, adId: string, upload: UploadRequest) {
    const [station] = (await database.query(`SELECT app.current_station_id() AS id`)) as Array<{ id: string }>;
    return {
      objectKey: `ad-uploads/${station?.id}/${adId}/${randomUUID()}`,
      displayFileName: cleanFileNameForDisplay(upload.fileName),
      expiresAt: new Date(Date.now() + UPLOAD_URL_LIFETIME_SECONDS * 1000),
    };
  }

  private async buildUploadInstructions(objectKey: string, upload: UploadRequest, expiresAt: Date): Promise<UploadInstructions> {
    return {
      method: 'PUT',
      url: await this.objectStorage.createUploadUrl(objectKey, upload.contentType, upload.sizeBytes, UPLOAD_URL_LIFETIME_SECONDS),
      headers: { 'Content-Type': upload.contentType },
      expiresAt: expiresAt.toISOString(),
    };
  }

  private async deleteObjectQuietly(objectKey: string): Promise<void> {
    try {
      await this.objectStorage.deleteObject(objectKey);
    } catch (error) {
      this.logger.warn({ err: error }, 'could not delete an uploaded object; it will be swept up later');
    }
  }
}


function describeUpload(upload: UploadRequest, displayFileName: string) {
  return { fileName: displayFileName, contentType: upload.contentType, sizeBytes: upload.sizeBytes };
}

/** Last path segment only, without control or bidirectional characters, at most 255 characters. */
export function cleanFileNameForDisplay(fileName: string): string {
  const lastSegment = fileName.split(/[\\/]/).pop() ?? '';
  const cleaned = lastSegment.replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g, '').trim();
  return Array.from(cleaned || 'audio').slice(0, 255).join('');
}
