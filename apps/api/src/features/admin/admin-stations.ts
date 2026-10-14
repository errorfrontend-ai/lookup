import type { AdminStationList, AdminStationListItem, AdminStationSearchInput, StationStatus } from '@lookup/contracts';
import { Injectable } from '@nestjs/common';
import { AuditTrail } from '../../common/audit/audit-trail.js';
import { AppError } from '../../common/errors/app-error.js';
import { AdminTransaction } from '../../infrastructure/admin-database/admin-database.module.js';
import { AdminApplications } from './admin-applications.js';

const PAGE_SIZE = 25;

interface StationListRow {
  id: string;
  name: string | null;
  frequency_label: string | null;
  city: string | null;
  province: string | null;
  status: StationStatus;
  member_count: number;
  reviewed_at: Date | null;
  sort_name: string;
}

/** `%`, `_` and `\` typed into the search are matched as themselves. */
function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * Stations for super admins (P5A design §3.3; P5A-ADMIN-STATIONS-*): every station, searched by part of its name,
 * frequency or town, in name order a page at a time; and suspension, which stops its ads reaching listeners at the
 * next recognition, and reactivation. Both are critical alerts to the station by SMS and email (P5A-D13).
 */
@Injectable()
export class AdminStations {
  constructor(
    private readonly adminTransaction: AdminTransaction,
    private readonly auditTrail: AuditTrail,
    private readonly applications: AdminApplications,
  ) {}

  async search(input: AdminStationSearchInput): Promise<AdminStationList> {
    const after = input.cursor ? readCursor(input.cursor) : null;
    const pattern = input.search ? `%${escapeLikePattern(input.search)}%` : null;
    const rows = (await this.adminTransaction.run((database) =>
      database.query(
        `SELECT station.id, station.name, station.frequency_label, station.city, station.province, station.status, station.reviewed_at,
                lower(coalesce(station.name, '')) AS sort_name,
                (SELECT count(*)::integer FROM app.station_memberships AS membership WHERE membership.station_id = station.id) AS member_count
           FROM app.stations AS station
          WHERE ($1::text IS NULL OR station.name ILIKE $1 OR station.frequency_label ILIKE $1 OR station.city ILIKE $1)
            AND ($2::text IS NULL OR (lower(coalesce(station.name, '')), station.id) > ($2, $3::uuid))
          ORDER BY lower(coalesce(station.name, '')), station.id
          LIMIT ${PAGE_SIZE + 1}`,
        [pattern, after?.sortName ?? null, after?.id ?? null],
      ),
    )) as StationListRow[];
    const page = rows.slice(0, PAGE_SIZE);
    const last = page[page.length - 1];
    return {
      stations: page.map(toListItem),
      nextCursor: rows.length > PAGE_SIZE && last ? Buffer.from(JSON.stringify({ sortName: last.sort_name, id: last.id })).toString('base64url') : null,
    };
  }

  async suspend(stationId: string, reason: string, requestId: string): Promise<void> {
    const station = await this.adminTransaction.run(async (database) => {
      const locked = await this.applications.lockStation(database, stationId);
      if (locked.status !== 'ACTIVE') throw new AppError('STATION_STATUS_CHANGE_NOT_ALLOWED', { internalDetail: `cannot suspend a ${locked.status} station` });
      await database.query(
        `UPDATE app.stations SET status = 'SUSPENDED', review_note = $2, reviewed_at = now(), reviewed_by_portal_user_id = app.current_user_id() WHERE id = $1`,
        [stationId, reason],
      );
      await this.auditTrail.record(database, { action: 'station_suspended', entityType: 'station', entityId: stationId, changes: { has_reason: true } });
      return locked;
    }, { stationId });
    await this.applications.tellStation(station, { template: 'station_suspended', stationName: station.name ?? '', reason }, requestId);
  }

  async reactivate(stationId: string, requestId: string): Promise<void> {
    const station = await this.adminTransaction.run(async (database) => {
      const locked = await this.applications.lockStation(database, stationId);
      if (locked.status !== 'SUSPENDED') throw new AppError('STATION_STATUS_CHANGE_NOT_ALLOWED', { internalDetail: `cannot reactivate a ${locked.status} station` });
      await database.query(
        `UPDATE app.stations SET status = 'ACTIVE', review_note = NULL, reviewed_at = now(), reviewed_by_portal_user_id = app.current_user_id() WHERE id = $1`,
        [stationId],
      );
      await this.auditTrail.record(database, { action: 'station_reactivated', entityType: 'station', entityId: stationId });
      return locked;
    }, { stationId });
    await this.applications.tellStation(station, { template: 'station_reactivated', stationName: station.name ?? '' }, requestId);
  }
}

function readCursor(cursor: string): { sortName: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { sortName?: unknown; id?: unknown };
    if (typeof parsed.sortName === 'string' && typeof parsed.id === 'string' && /^[0-9a-f-]{36}$/.test(parsed.id)) return { sortName: parsed.sortName, id: parsed.id };
  } catch {
    // Falls through to the refusal below.
  }
  throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'cursor', code: 'invalid_cursor' }], internalDetail: 'unreadable station cursor' });
}

function toListItem(row: StationListRow): AdminStationListItem {
  return {
    id: row.id,
    name: row.name,
    frequencyLabel: row.frequency_label,
    city: row.city,
    province: row.province,
    status: row.status,
    memberCount: row.member_count,
    lastDecisionAt: row.reviewed_at?.toISOString() ?? null,
  };
}
