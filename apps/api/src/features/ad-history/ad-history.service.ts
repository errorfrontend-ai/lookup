import { AD_HISTORY_EVENTS_PER_PAGE, type AdHistoryPage } from '@lookup/contracts';
import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error.js';
import { StationScopedTransaction } from '../../infrastructure/database/station-scoped-transaction.js';
import { findAdRecord } from '../ads/ad-records.js';
import { AD_HISTORY_ACTIONS, type AdHistoryAuditRow, describeAdHistoryEvent } from './describe-ad-history-event.js';

const CURSOR_PATTERN = /^\d{1,18}$/;

/** What happened to an ad, newest first: who changed what and when, read from the station's audit trail. */
@Injectable()
export class AdHistoryService {
  constructor(private readonly stationScopedTransaction: StationScopedTransaction) {}

  async list(adId: string, cursor: string | undefined): Promise<AdHistoryPage> {
    if (cursor !== undefined && !CURSOR_PATTERN.test(cursor)) {
      throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'cursor', code: 'invalid_cursor' }], internalDetail: 'malformed history cursor' });
    }
    const rows = await this.stationScopedTransaction.run(async (database) => {
      // Another station's ad (or none, or an archived one) answers 404 here, before any history is read.
      await findAdRecord(database, adId);
      // The actor's name comes through the same row-level security as everything else: people still on
      // the station's team are visible, and a former member's rows simply have no name.
      return (await database.query(
        `SELECT audit.id::text AS id,
                to_char(audit.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at_text,
                audit.action, audit.changes,
                actor.full_name AS actor_full_name,
                saved_card.content AS saved_card_content,
                previous_card.content AS previous_card_content
           FROM app.audit_events AS audit
           LEFT JOIN app.portal_users AS actor ON actor.id = audit.actor_portal_user_id
           LEFT JOIN app.action_cards AS saved_card
                  ON audit.action = 'action_card_saved' AND saved_card.id = audit.entity_id
           LEFT JOIN app.action_cards AS previous_card
                  ON audit.action = 'action_card_saved' AND previous_card.id = (audit.changes ->> 'previousActionCardId')::uuid
          WHERE audit.station_id = app.current_station_id()
            AND audit.action = ANY($2::text[])
            AND ((audit.entity_type = 'ad' AND audit.entity_id = $1::uuid)
                 OR (audit.changes ? 'adId' AND (audit.changes ->> 'adId') = $1::text))
            AND ($3::bigint IS NULL OR audit.id < $3::bigint)
          ORDER BY audit.id DESC
          LIMIT ${AD_HISTORY_EVENTS_PER_PAGE + 1}`,
        [adId, [...AD_HISTORY_ACTIONS], cursor ?? null],
      )) as AdHistoryAuditRow[];
    });

    const pageRows = rows.slice(0, AD_HISTORY_EVENTS_PER_PAGE);
    const lastRow = pageRows[pageRows.length - 1];
    return {
      events: pageRows.flatMap((row) => describeAdHistoryEvent(row) ?? []),
      nextCursor: rows.length > AD_HISTORY_EVENTS_PER_PAGE && lastRow ? lastRow.id : null,
    };
  }
}
