import type { ChangeRequestDecision, RequestStationDetailChangeInput, StationChangeRequest, StationChangeRequestState } from '@lookup/contracts';
import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { AppError } from '../../common/errors/app-error.js';
import { isUniqueViolation } from '../../common/errors/database-errors.js';
import { StationScopedTransaction } from '../../infrastructure/database/station-scoped-transaction.js';
import type { RequestFacts } from '../authentication/authentication.service.js';
import { StationUploads } from './station-uploads.js';

interface ChangeRequestRow {
  id: string;
  requested_at: Date;
  name: string;
  frequency_label: string;
  licence_number: string;
  licence_document_file_name: string | null;
  decision: ChangeRequestDecision | null;
  decision_note: string | null;
  decided_at: Date | null;
}

/**
 * O2 as the user chose (P5A-D4; journey E): an approved station asks to change its name, frequency or licence, and
 * stays live under its approved details until a super admin decides. One request at a time; a new licence document
 * is uploaded and checked first, then named by the request.
 */
@Injectable()
export class StationChangeRequests {
  constructor(
    private readonly stationScopedTransaction: StationScopedTransaction,
    private readonly stationUploads: StationUploads,
  ) {}

  /** The approved details, the request waiting (if any) and the last one decided; any member reads it. */
  read(): Promise<StationChangeRequestState> {
    return this.stationScopedTransaction.run((database) => this.readWithin(database));
  }

  async request(input: RequestStationDetailChangeInput, request: RequestFacts): Promise<StationChangeRequestState> {
    const document = input.licenceDocumentUploadId ? await this.stationUploads.takeCheckedChangeDocument(input.licenceDocumentUploadId) : null;
    if (input.licenceDocumentUploadId && !document) {
      throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'licenceDocumentUploadId', code: 'upload_not_received' }], internalDetail: 'no checked document for that upload' });
    }
    let outcome: string | undefined;
    try {
      [{ outcome }] = (await this.stationScopedTransaction.run((database) =>
        database.query('SELECT outcome FROM app.request_station_detail_change(app.current_station_id(), $1, $2, $3, $4, $5, $6, $7, $8)', [
          input.name,
          input.frequencyLabel,
          input.licenceNumber,
          document?.objectKey ?? null,
          document?.fileName ?? null,
          document?.contentType ?? null,
          document?.byteCount ?? null,
          request.requestId,
        ]),
      )) as Array<{ outcome: string }>;
    } catch (problem) {
      if (document) await this.stationUploads.discardChangeDocument(document.objectKey);
      // Two requests at the same moment: the second meets the one-open-request index.
      if (isUniqueViolation(problem, 'station_change_requests_one_open_unique_index')) {
        throw new AppError('CHANGE_REQUEST_ALREADY_OPEN', { internalDetail: 'a change request opened at the same moment', cause: problem });
      }
      throw problem;
    }
    if (outcome !== 'REQUESTED' && document) await this.stationUploads.discardChangeDocument(document.objectKey);
    if (outcome === 'ALREADY_OPEN') throw new AppError('CHANGE_REQUEST_ALREADY_OPEN', { internalDetail: 'a change request is already open' });
    if (outcome === 'NOTHING_CHANGED') {
      throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'name', code: 'nothing_changed' }], internalDetail: 'the change request changes nothing' });
    }
    if (outcome === 'NOT_EDITABLE') throw new AppError('APPLICATION_NOT_EDITABLE', { internalDetail: 'only an approved station asks for a change' });
    if (outcome !== 'REQUESTED') throw new AppError('FORBIDDEN', { internalDetail: `change request refused: ${outcome ?? 'no result'}` });
    return this.read();
  }

  async withdraw(request: RequestFacts): Promise<StationChangeRequestState> {
    const [result] = (await this.stationScopedTransaction.run((database) =>
      database.query('SELECT * FROM app.withdraw_station_detail_change(app.current_station_id(), $1)', [request.requestId]),
    )) as Array<{ outcome: string; withdrawn_document_object_key: string | null }>;
    if (result?.outcome === 'NONE_OPEN') throw new AppError('NOT_FOUND', { internalDetail: 'no change request is open' });
    if (result?.outcome !== 'WITHDRAWN') throw new AppError('FORBIDDEN', { internalDetail: `withdrawal refused: ${result?.outcome ?? 'no result'}` });
    if (result.withdrawn_document_object_key) await this.stationUploads.discardChangeDocument(result.withdrawn_document_object_key);
    return this.read();
  }

  private async readWithin(database: EntityManager): Promise<StationChangeRequestState> {
    const [station] = (await database.query(
      'SELECT name, frequency_label, licence_number FROM app.stations WHERE id = app.current_station_id()',
    )) as Array<{ name: string | null; frequency_label: string | null; licence_number: string | null }>;
    if (!station) throw new AppError('NOT_FOUND', { internalDetail: 'station not visible' });
    const requests = (await database.query(
      `SELECT id, requested_at, name, frequency_label, licence_number, licence_document_file_name, decision, decision_note, decided_at
         FROM app.station_change_requests WHERE station_id = app.current_station_id()
        ORDER BY (decision IS NULL) DESC, coalesce(decided_at, requested_at) DESC LIMIT 2`,
    )) as ChangeRequestRow[];
    const open = requests.find((row) => row.decision === null) ?? null;
    const lastDecided = requests.find((row) => row.decision !== null) ?? null;
    return {
      approved: { name: station.name ?? '', frequencyLabel: station.frequency_label ?? '', licenceNumber: station.licence_number },
      open: open ? describe(open) : null,
      lastDecided: lastDecided ? describe(lastDecided) : null,
    };
  }
}

function describe(row: ChangeRequestRow): StationChangeRequest {
  return {
    id: row.id,
    requestedAt: row.requested_at.toISOString(),
    name: row.name,
    frequencyLabel: row.frequency_label,
    licenceNumber: row.licence_number,
    hasNewLicenceDocument: row.licence_document_file_name !== null,
    decision: row.decision,
    // A withdrawal has no note; a refusal's reason is the station's to read.
    decisionNote: row.decision_note,
    decidedAt: row.decided_at?.toISOString() ?? null,
  };
}
