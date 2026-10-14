import { randomUUID } from 'node:crypto';
import type { StartLicenceDocumentUploadInput, StartStationLogoUploadInput, StationFileRefusalReason, StationUploadAddress } from '@lookup/contracts';
import { Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import type { Redis } from 'ioredis';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { AuditTrail } from '../../common/audit/audit-trail.js';
import { AppError } from '../../common/errors/app-error.js';
import { RateLimiter } from '../../common/rate-limiting/rate-limiter.js';
import { StationScopedTransaction } from '../../infrastructure/database/station-scoped-transaction.js';
import { KEY_VALUE_STORE } from '../../infrastructure/key-value-store/key-value-store.module.js';
import { ObjectStorage } from '../../infrastructure/object-storage/object-storage.js';
import type { RequestFacts } from '../authentication/authentication.service.js';
import { STATION_UPLOAD_ADDRESSES_PER_STATION } from './registration-rate-limits.js';
import { isPngOrJpeg, StationLogoProcessor } from './station-logo-processing.js';

/** A signed upload address lasts 10 minutes; the pending upload is remembered for 15 (P5A design §3.2). */
const UPLOAD_ADDRESS_SECONDS = 10 * 60;
const PENDING_UPLOAD_SECONDS = 15 * 60;
const PDF_SIGNATURE = Buffer.from('%PDF-', 'latin1');

/** A logo, the application's licence document, or the new licence document of an approved station's change (O2). */
export type StationUploadPurpose = 'logo' | 'licence-document' | 'change-request-document';

interface PendingUpload {
  stationId: string;
  purpose: StationUploadPurpose;
  objectKey: string;
  fileName: string;
  contentType: string;
  byteCount: number;
  /** A change request's document, checked and waiting for the request that names it. */
  isChecked?: boolean;
}

/** A checked document a change request may take. */
export interface CheckedLicenceDocument {
  objectKey: string;
  fileName: string;
  contentType: string;
  byteCount: number;
}

/**
 * A station's own files (P5A design §3.2; P5A-STATION-DETAILS-04..06, P5A-LICENCE-02..05): the browser asks for a
 * signed address, sends the file straight to the private bucket, then asks the API to check it. The key is made by
 * the server from nothing the applicant typed; the signature fixes the type and the length; the check compares what
 * arrived with what was signed and reads its first bytes before anything decodes it. A refused file is deleted.
 */
@Injectable()
export class StationUploads {
  constructor(
    @Inject(KEY_VALUE_STORE) private readonly keyValueStore: Redis,
    private readonly objectStorage: ObjectStorage,
    private readonly stationScopedTransaction: StationScopedTransaction,
    private readonly requestContext: ClsService,
    private readonly rateLimiter: RateLimiter,
    private readonly auditTrail: AuditTrail,
    private readonly logoProcessor: StationLogoProcessor,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('station-uploads');
  }

  async start(purpose: StationUploadPurpose, input: StartStationLogoUploadInput | StartLicenceDocumentUploadInput, response: Response): Promise<StationUploadAddress> {
    const stationId = this.requestContext.get<string>('stationId');
    await this.rateLimiter.countRequest(STATION_UPLOAD_ADDRESSES_PER_STATION, stationId, response);
    const uploadId = randomUUID();
    const folder = purpose === 'logo' ? 'station-logo-uploads' : purpose === 'licence-document' ? 'licence-documents' : 'licence-change-documents';
    const pending: PendingUpload = {
      stationId,
      purpose,
      objectKey: `${folder}/${stationId}/${randomUUID()}`,
      fileName: input.fileName,
      contentType: input.contentType,
      byteCount: input.byteCount,
    };
    await this.keyValueStore.set(this.pendingKey(uploadId), JSON.stringify(pending), 'EX', PENDING_UPLOAD_SECONDS).catch((problem: unknown) => {
      throw new AppError('SERVICE_UNAVAILABLE', { internalDetail: 'pending upload store unavailable', cause: problem });
    });
    const uploadUrl = await this.objectStorage.createUploadUrlIn(this.bucketFor(purpose), pending.objectKey, pending.contentType, pending.byteCount, UPLOAD_ADDRESS_SECONDS);
    return { uploadId, uploadUrl, expiresAt: new Date(Date.now() + UPLOAD_ADDRESS_SECONDS * 1000).toISOString() };
  }

  /**
   * Checks what arrived. A logo is processed into a WebP that replaces the station's logo (the original is deleted);
   * a licence document is attached to the application (the one it replaces is deleted).
   */
  async complete(purpose: StationUploadPurpose, uploadId: string, request: RequestFacts): Promise<void> {
    const stationId = this.requestContext.get<string>('stationId');
    const stored = await this.keyValueStore.get(this.pendingKey(uploadId)).catch((problem: unknown) => {
      throw new AppError('SERVICE_UNAVAILABLE', { internalDetail: 'pending upload store unavailable', cause: problem });
    });
    const pending = stored ? (JSON.parse(stored) as PendingUpload) : null;
    // Another station's upload id, or another purpose's, is as unknown as one that never existed.
    if (!pending || pending.stationId !== stationId || pending.purpose !== purpose || pending.isChecked) {
      throw new AppError('NOT_FOUND', { internalDetail: 'no such pending upload for this station' });
    }
    const bucket = this.bucketFor(purpose);
    const facts = await this.objectStorage.describeObjectIn(bucket, pending.objectKey);
    if (!facts) throw this.refusal('upload_not_received', 'UPLOAD_NOT_RECEIVED');
    if (facts.sizeBytes !== pending.byteCount || facts.contentType !== pending.contentType) {
      await this.discard(bucket, pending.objectKey);
      throw this.refusal(facts.sizeBytes > pending.byteCount ? 'file_too_large' : 'wrong_file_type');
    }
    const firstBytes = await this.objectStorage.readFirstBytesIn(bucket, pending.objectKey, facts.entityTag, 8);
    if (purpose !== 'logo') {
      const isExpectedFile = pending.contentType === 'application/pdf' ? firstBytes.subarray(0, 5).equals(PDF_SIGNATURE) : isPngOrJpeg(firstBytes) && firstBytes[0] === 0xff;
      if (!isExpectedFile) {
        await this.discard(bucket, pending.objectKey);
        throw this.refusal('wrong_file_type');
      }
    }
    if (purpose === 'change-request-document') {
      // Kept until the change request names it (or the key expires and the file is an orphan the storage keeps).
      await this.keyValueStore.set(this.pendingKey(uploadId), JSON.stringify({ ...pending, isChecked: true }), 'EX', PENDING_UPLOAD_SECONDS);
      return;
    }
    if (purpose === 'licence-document') {
      const [attached] = (await this.stationScopedTransaction.run((database) =>
        database.query('SELECT * FROM app.attach_station_licence_document(app.current_station_id(), $1, $2, $3, $4, $5)', [
          pending.objectKey,
          pending.fileName,
          pending.contentType,
          pending.byteCount,
          request.requestId,
        ]),
      )) as Array<{ outcome: string; replaced_object_key: string | null }>;
      if (attached?.outcome !== 'ATTACHED') {
        await this.discard(bucket, pending.objectKey);
        throw new AppError(attached?.outcome === 'NOT_EDITABLE' ? 'APPLICATION_NOT_EDITABLE' : 'FORBIDDEN', { internalDetail: `licence document refused: ${attached?.outcome}` });
      }
      if (attached.replaced_object_key) await this.discard(bucket, attached.replaced_object_key);
    } else {
      if (!isPngOrJpeg(firstBytes)) {
        await this.discard(bucket, pending.objectKey);
        throw this.refusal('wrong_file_type');
      }
      const processed = await this.logoProcessor.process(await this.objectStorage.readObjectIn(bucket, pending.objectKey, facts.entityTag));
      await this.discard(bucket, pending.objectKey);
      if (!processed.isProcessed) throw this.refusal(processed.reason);
      const logoKey = `station-logos/${stationId}/${randomUUID()}.webp`;
      await this.objectStorage.putObjectIn(bucket, logoKey, processed.webp, 'image/webp');
      const previousKey = await this.stationScopedTransaction.run(async (database) => {
        const [before] = (await database.query('SELECT logo_object_key FROM app.stations WHERE id = app.current_station_id() FOR UPDATE')) as Array<{
          logo_object_key: string | null;
        }>;
        await database.query('UPDATE app.stations SET logo_object_key = $1 WHERE id = app.current_station_id()', [logoKey]);
        await this.auditTrail.record(database, {
          action: 'station_logo_changed',
          entityType: 'station',
          entityId: stationId,
          changes: { width: processed.width, height: processed.height, is_replacement: Boolean(before?.logo_object_key) },
        });
        return before?.logo_object_key ?? null;
      });
      if (previousKey) await this.discard(bucket, previousKey);
    }
    await this.keyValueStore.del(this.pendingKey(uploadId)).catch(() => undefined);
  }

  /** The checked change-request document an upload id names, taken so no second request can use it; null when none. */
  async takeCheckedChangeDocument(uploadId: string): Promise<CheckedLicenceDocument | null> {
    const stationId = this.requestContext.get<string>('stationId');
    const stored = await this.keyValueStore.getdel(this.pendingKey(uploadId)).catch((problem: unknown) => {
      throw new AppError('SERVICE_UNAVAILABLE', { internalDetail: 'pending upload store unavailable', cause: problem });
    });
    const pending = stored ? (JSON.parse(stored) as PendingUpload) : null;
    if (!pending || pending.stationId !== stationId || pending.purpose !== 'change-request-document' || !pending.isChecked) return null;
    return { objectKey: pending.objectKey, fileName: pending.fileName, contentType: pending.contentType, byteCount: pending.byteCount };
  }

  /** Deletes a change request's document that will not be used (a refused or withdrawn request). */
  async discardChangeDocument(objectKey: string): Promise<void> {
    await this.discard(this.objectStorage.licenceDocumentsBucket, objectKey);
  }

  private bucketFor(purpose: StationUploadPurpose): string {
    return purpose === 'logo' ? this.objectStorage.stationLogosBucket : this.objectStorage.licenceDocumentsBucket;
  }

  private pendingKey(uploadId: string): string {
    return `station-upload:${uploadId}`;
  }

  private refusal(reason: StationFileRefusalReason, code: 'STATION_FILE_REJECTED' | 'UPLOAD_NOT_RECEIVED' = 'STATION_FILE_REJECTED'): AppError {
    return new AppError(code, { fields: [{ path: 'file', code: reason }], internalDetail: `station file refused: ${reason}` });
  }

  /** Deletes a stored file; a failure is logged, never answered, because the answer is already decided. */
  private async discard(bucket: string, objectKey: string): Promise<void> {
    await this.objectStorage.deleteObjectIn(bucket, objectKey).catch((problem: unknown) => {
      this.logger.warn({ err: problem }, 'could not delete a station file');
    });
  }
}
