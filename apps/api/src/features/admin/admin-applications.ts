import type { ApplicationDetail, ApplicationKind, ApplicationQueue, ApplicationQueueEntry, LicenceDocumentSummary, PrivateFileLink, StationStatus } from '@lookup/contracts';
import { maskPhoneNumberForDisplay } from '@lookup/contracts';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { EntityManager } from 'typeorm';
import { AuditTrail } from '../../common/audit/audit-trail.js';
import { AppError } from '../../common/errors/app-error.js';
import { AdminTransaction } from '../../infrastructure/admin-database/admin-database.module.js';
import { ObjectStorage } from '../../infrastructure/object-storage/object-storage.js';
import type { NotificationMessage } from '../notifications/notification-messages.js';
import { NotificationQueue } from '../notifications/notification-queue.js';

/** A licence document opens through a 5-minute link only (P5A-LICENCE-04, P5A-ADMIN-QUEUE-10, -11). */
const LICENCE_LINK_SECONDS = 5 * 60;

/** Another station already on this frequency in this town (P5A-D17): any status but rejected or still signing up. */
const duplicateStatusOf = (frequency: string, stationId: string) => `(
  SELECT other.status FROM app.stations AS other
   WHERE other.id <> ${stationId} AND other.status NOT IN ('REJECTED', 'PENDING_VERIFICATION')
     AND lower(regexp_replace(other.frequency_label, '\\s', '', 'g')) = lower(regexp_replace(${frequency}, '\\s', '', 'g'))
     AND lower(btrim(other.city)) = lower(btrim(station.city))
   ORDER BY other.created_at LIMIT 1)`;

interface QueueRow {
  station_id: string;
  kind: ApplicationKind;
  change_request_id: string | null;
  name: string;
  frequency_label: string;
  city: string | null;
  province: string | null;
  submitted_at: Date;
  duplicate_status: StationStatus | null;
}

interface StationForDecision {
  id: string;
  name: string | null;
  status: StationStatus;
  contact_phone_number_e164: string | null;
  licence_number: string | null;
  licence_document_object_key: string | null;
  owner_email: string | null;
}

/**
 * The applications queue and its decisions (P5A design §3.3; journeys C and D; P5A-ADMIN-QUEUE-*): new stations and
 * changes asked for by approved ones, oldest first, each decision audited with the super admin as actor and followed
 * by an SMS and an email to the station. Status moves are checked again by the database's trigger.
 */
@Injectable()
export class AdminApplications {
  constructor(
    private readonly adminTransaction: AdminTransaction,
    private readonly auditTrail: AuditTrail,
    private readonly objectStorage: ObjectStorage,
    private readonly notifications: NotificationQueue,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('admin');
  }

  async readQueue(): Promise<ApplicationQueue> {
    const rows = (await this.adminTransaction.run((database) =>
      database.query(
        `SELECT station.id AS station_id, 'NEW_STATION' AS kind, NULL::uuid AS change_request_id, station.name, station.frequency_label,
                station.city, station.province, station.application_submitted_at AS submitted_at,
                ${duplicateStatusOf('station.frequency_label', 'station.id')} AS duplicate_status
           FROM app.stations AS station WHERE station.status = 'PENDING_REVIEW'
         UNION ALL
         SELECT station.id, 'DETAIL_CHANGE', request.id, request.name, request.frequency_label, station.city, station.province,
                request.requested_at, ${duplicateStatusOf('request.frequency_label', 'station.id')}
           FROM app.station_change_requests AS request JOIN app.stations AS station ON station.id = request.station_id
          WHERE request.decision IS NULL
         ORDER BY submitted_at, station_id`,
      ),
    )) as QueueRow[];
    return { entries: rows.map(toQueueEntry) };
  }

  async readDetail(stationId: string): Promise<ApplicationDetail> {
    return this.adminTransaction.run(async (database) => {
      const [station] = (await database.query(
        `SELECT station.*, ${duplicateStatusOf('station.frequency_label', 'station.id')} AS duplicate_status
           FROM app.stations AS station WHERE station.id = $1`,
        [stationId],
      )) as Array<Record<string, unknown> & { status: StationStatus }>;
      if (!station) throw new AppError('NOT_FOUND', { internalDetail: 'no such station' });
      const [request] = (await database.query(
        `SELECT request.*, ${duplicateStatusOf('request.frequency_label', 'station.id')} AS duplicate_status
           FROM app.station_change_requests AS request JOIN app.stations AS station ON station.id = request.station_id
          WHERE request.station_id = $1 AND request.decision IS NULL`,
        [stationId],
      )) as Array<Record<string, unknown>>;
      if (station.status !== 'PENDING_REVIEW' && !request) throw new AppError('NOT_FOUND', { internalDetail: 'nothing waiting for review' });
      const isChange = station.status !== 'PENDING_REVIEW';
      const base = toQueueEntry({
        station_id: stationId,
        kind: isChange ? 'DETAIL_CHANGE' : 'NEW_STATION',
        change_request_id: isChange ? (request?.id as string) : null,
        name: (station.name as string) ?? '',
        frequency_label: (station.frequency_label as string) ?? '',
        city: station.city as string | null,
        province: station.province as string | null,
        submitted_at: (isChange ? request?.requested_at : station.application_submitted_at) as Date,
        duplicate_status: (isChange ? request?.duplicate_status : station.duplicate_status) as StationStatus | null,
      });
      const phone = station.contact_phone_number_e164 as string | null;
      return {
        ...base,
        checks: {
          isPhoneVerified: station.phone_verified_at !== null,
          isEmailVerified: station.email_verified_at !== null,
          hasLicenceDocument: station.licence_document_object_key !== null,
        },
        contact: { name: station.contact_name as string | null, phoneNumberMasked: phone ? maskPhoneNumberForDisplay(phone) : null },
        licenceNumber: station.licence_number as string | null,
        timeZone: station.time_zone as string,
        coverageNote: station.coverage_note as string | null,
        streamAddress: station.stream_address as string | null,
        licenceDocument: documentSummary(station, 'licence_document_uploaded_at'),
        proposedChange: request
          ? {
              name: request.name as string,
              frequencyLabel: request.frequency_label as string,
              licenceNumber: request.licence_number as string,
              licenceDocument: documentSummary(request, 'requested_at'),
            }
          : null,
      };
    });
  }

  /** A 5-minute link to a licence document: the station's, or the one a change request carries. */
  async createLicenceDocumentLink(stationId: string, changeRequestId: string | null): Promise<PrivateFileLink> {
    const document = await this.adminTransaction.run(async (database) => {
      const rows = changeRequestId
        ? await database.query(
            `SELECT licence_document_object_key AS object_key, licence_document_file_name AS file_name, licence_document_content_type AS content_type
               FROM app.station_change_requests WHERE id = $1`,
            [changeRequestId],
          )
        : await database.query(
            `SELECT licence_document_object_key AS object_key, licence_document_file_name AS file_name, licence_document_content_type AS content_type
               FROM app.stations WHERE id = $1`,
            [stationId],
          );
      const [row] = rows as Array<{ object_key: string | null; file_name: string | null; content_type: string | null }>;
      if (!row?.object_key || !row.content_type) throw new AppError('NOT_FOUND', { internalDetail: 'no licence document' });
      await this.auditTrail.record(database, {
        action: 'licence_document_opened',
        entityType: changeRequestId ? 'station_change_request' : 'station',
        entityId: changeRequestId ?? stationId,
      });
      return row as { object_key: string; file_name: string | null; content_type: string };
    }, { stationId });
    const address = await this.objectStorage.createDownloadUrlIn(this.objectStorage.licenceDocumentsBucket, document.object_key, LICENCE_LINK_SECONDS, {
      contentType: document.content_type,
      fileName: document.file_name ?? 'licence',
    });
    return { address, contentType: document.content_type, expiresAt: new Date(Date.now() + LICENCE_LINK_SECONDS * 1000).toISOString() };
  }

  /** Approves a new station (O5: only with its licence number and document; P5A-ADMIN-QUEUE-19). */
  async approve(stationId: string, requestId: string): Promise<void> {
    const station = await this.adminTransaction.run(async (database) => {
      const locked = await this.lockStation(database, stationId);
      if (locked.status !== 'PENDING_REVIEW') throw notAllowed(`approve from ${locked.status}`);
      if (!locked.licence_number || !locked.licence_document_object_key) {
        throw new AppError('STATION_STATUS_CHANGE_NOT_ALLOWED', { internalDetail: 'no licence number or document to approve on' });
      }
      await database.query(
        `UPDATE app.stations SET status = 'ACTIVE', review_note = NULL, reviewed_at = now(), reviewed_by_portal_user_id = app.current_user_id() WHERE id = $1`,
        [stationId],
      );
      await this.auditTrail.record(database, { action: 'station_application_approved', entityType: 'station', entityId: stationId });
      return locked;
    }, { stationId });
    await this.tellStation(station, { template: 'application_approved', stationName: station.name ?? '' }, requestId);
  }

  /** Rejects a new station with a reason the station reads word for word (journey D). */
  async reject(stationId: string, reason: string, requestId: string): Promise<void> {
    const station = await this.adminTransaction.run(async (database) => {
      const locked = await this.lockStation(database, stationId);
      if (locked.status !== 'PENDING_REVIEW') throw notAllowed(`reject from ${locked.status}`);
      await database.query(
        `UPDATE app.stations SET status = 'REJECTED', review_note = $2, reviewed_at = now(), reviewed_by_portal_user_id = app.current_user_id() WHERE id = $1`,
        [stationId, reason],
      );
      // The reason may name people: the station row keeps it; the audit row says only that there was one.
      await this.auditTrail.record(database, { action: 'station_application_rejected', entityType: 'station', entityId: stationId, changes: { has_reason: true } });
      return locked;
    }, { stationId });
    await this.tellStation(station, { template: 'application_rejected', stationName: station.name ?? '', reason }, requestId);
  }

  /** Approves a change (O2): the station takes the new details, and a replaced licence document is deleted. */
  async approveChange(changeRequestId: string, requestId: string): Promise<void> {
    const { station, replacedDocumentKey } = await this.adminTransaction.run(async (database) => {
      const request = await this.lockOpenChangeRequest(database, changeRequestId);
      const locked = await this.lockStation(database, request.station_id);
      if (locked.status !== 'ACTIVE') throw notAllowed(`change a ${locked.status} station`);
      const hasDocument = request.licence_document_object_key !== null;
      await database.query(
        `UPDATE app.stations
            SET name = $2, frequency_label = $3, licence_number = $4,
                licence_document_object_key = CASE WHEN $5 THEN $6 ELSE licence_document_object_key END,
                licence_document_file_name = CASE WHEN $5 THEN $7 ELSE licence_document_file_name END,
                licence_document_content_type = CASE WHEN $5 THEN $8 ELSE licence_document_content_type END,
                licence_document_byte_count = CASE WHEN $5 THEN $9::integer ELSE licence_document_byte_count END,
                licence_document_uploaded_at = CASE WHEN $5 THEN now() ELSE licence_document_uploaded_at END,
                reviewed_at = now(), reviewed_by_portal_user_id = app.current_user_id()
          WHERE id = $1`,
        [
          locked.id, request.name, request.frequency_label, request.licence_number, hasDocument,
          request.licence_document_object_key, request.licence_document_file_name, request.licence_document_content_type, request.licence_document_byte_count,
        ],
      );
      await database.query(
        `UPDATE app.station_change_requests SET decision = 'APPROVED', decided_at = now(), decided_by_portal_user_id = app.current_user_id() WHERE id = $1`,
        [changeRequestId],
      );
      await this.auditTrail.record(database, {
        action: 'station_detail_change_approved',
        entityType: 'station_change_request',
        entityId: changeRequestId,
        changes: { is_licence_document_replaced: hasDocument },
      });
      return { station: { ...locked, name: request.name }, replacedDocumentKey: hasDocument ? locked.licence_document_object_key : null };
    }, { stationId: await this.stationOfChangeRequest(changeRequestId) });
    if (replacedDocumentKey) await this.discardDocument(replacedDocumentKey);
    await this.tellStation(station, { template: 'change_request_approved', stationName: station.name ?? '' }, requestId);
  }

  /** Refuses a change: the station keeps its approved details; the request's document is deleted. */
  async rejectChange(changeRequestId: string, reason: string, requestId: string): Promise<void> {
    const { station, documentKey } = await this.adminTransaction.run(async (database) => {
      const request = await this.lockOpenChangeRequest(database, changeRequestId);
      const locked = await this.lockStation(database, request.station_id);
      await database.query(
        `UPDATE app.station_change_requests SET decision = 'REJECTED', decision_note = $2, decided_at = now(), decided_by_portal_user_id = app.current_user_id() WHERE id = $1`,
        [changeRequestId, reason],
      );
      await this.auditTrail.record(database, { action: 'station_detail_change_rejected', entityType: 'station_change_request', entityId: changeRequestId, changes: { has_reason: true } });
      return { station: locked, documentKey: request.licence_document_object_key };
    }, { stationId: await this.stationOfChangeRequest(changeRequestId) });
    if (documentKey) await this.discardDocument(documentKey);
    await this.tellStation(station, { template: 'change_request_rejected', stationName: station.name ?? '', reason }, requestId);
  }

  // ---- helpers ---------------------------------------------------------------------------------------------

  async lockStation(database: EntityManager, stationId: string): Promise<StationForDecision> {
    const [station] = (await database.query(
      `SELECT station.id, station.name, station.status, station.contact_phone_number_e164, station.licence_number,
              station.licence_document_object_key,
              (SELECT owner.email::text FROM app.station_memberships AS membership
                 JOIN app.portal_users AS owner ON owner.id = membership.portal_user_id
                WHERE membership.station_id = station.id AND membership.role = 'OWNER' AND owner.status = 'ACTIVE'
                ORDER BY membership.created_at LIMIT 1) AS owner_email
         FROM app.stations AS station WHERE station.id = $1 FOR UPDATE OF station`,
      [stationId],
    )) as StationForDecision[];
    if (!station) throw new AppError('NOT_FOUND', { internalDetail: 'no such station' });
    return station;
  }

  /** The SMS and the email of a decision (P5A design §3.6). A queueing failure is logged: the decision stands. */
  async tellStation(station: StationForDecision, message: NotificationMessage, requestId: string): Promise<void> {
    const sends: Array<Promise<void>> = [];
    if (station.contact_phone_number_e164) sends.push(this.notifications.enqueue('sms', station.contact_phone_number_e164, message, requestId));
    if (station.owner_email) sends.push(this.notifications.enqueue('email', station.owner_email, message, requestId));
    for (const outcome of await Promise.allSettled(sends)) {
      if (outcome.status === 'rejected') this.logger.warn({ err: outcome.reason, requestId, template: message.template }, 'a decision notification was not queued');
    }
  }

  private async lockOpenChangeRequest(database: EntityManager, changeRequestId: string) {
    const [request] = (await database.query(
      `SELECT * FROM app.station_change_requests WHERE id = $1 AND decision IS NULL FOR UPDATE`,
      [changeRequestId],
    )) as Array<{
      station_id: string;
      name: string;
      frequency_label: string;
      licence_number: string;
      licence_document_object_key: string | null;
      licence_document_file_name: string | null;
      licence_document_content_type: string | null;
      licence_document_byte_count: number | null;
    }>;
    if (!request) throw new AppError('NOT_FOUND', { internalDetail: 'no open change request with that id' });
    return request;
  }

  private async stationOfChangeRequest(changeRequestId: string): Promise<string> {
    const [row] = (await this.adminTransaction.run((database) =>
      database.query('SELECT station_id FROM app.station_change_requests WHERE id = $1', [changeRequestId]),
    )) as Array<{ station_id: string }>;
    if (!row) throw new AppError('NOT_FOUND', { internalDetail: 'no change request with that id' });
    return row.station_id;
  }

  private async discardDocument(objectKey: string): Promise<void> {
    await this.objectStorage.deleteObjectIn(this.objectStorage.licenceDocumentsBucket, objectKey).catch((problem: unknown) => {
      this.logger.warn({ err: problem }, 'could not delete a licence document');
    });
  }
}

function toQueueEntry(row: QueueRow): ApplicationQueueEntry {
  return {
    stationId: row.station_id,
    kind: row.kind,
    changeRequestId: row.change_request_id,
    name: row.name,
    frequencyLabel: row.frequency_label,
    city: row.city,
    province: row.province,
    submittedAt: row.submitted_at.toISOString(),
    duplicate: row.duplicate_status ? { matchedStationStatus: row.duplicate_status } : null,
  };
}

function documentSummary(row: Record<string, unknown>, uploadedAtColumn: string): LicenceDocumentSummary | null {
  if (!row.licence_document_object_key) return null;
  return {
    fileName: row.licence_document_file_name as string,
    contentType: row.licence_document_content_type as LicenceDocumentSummary['contentType'],
    byteCount: row.licence_document_byte_count as number,
    uploadedAt: (row[uploadedAtColumn] as Date).toISOString(),
  };
}

function notAllowed(move: string): AppError {
  return new AppError('STATION_STATUS_CHANGE_NOT_ALLOWED', { internalDetail: `cannot ${move}` });
}
