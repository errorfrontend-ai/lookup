import type { ActionCard, AdDetail } from '@lookup/contracts';
import { Injectable } from '@nestjs/common';
import { AuditTrail } from '../../common/audit/audit-trail.js';
import { StationScopedTransaction } from '../../infrastructure/database/station-scoped-transaction.js';
import { findAdRecord, lockAndFindAdRecord, toAdDetail } from '../ads/ad-records.js';
import { describeActionCardChanges } from './action-card-changes.js';

/** An ad's buttons: every save is a new, immutable card version. */
@Injectable()
export class ActionCardsService {
  constructor(
    private readonly stationScopedTransaction: StationScopedTransaction,
    private readonly auditTrail: AuditTrail,
  ) {}

  /**
   * Saves the buttons as a new card version and makes it the ad's current one. A campaign that is
   * already live switches to it at once, so a corrected phone number reaches listeners straight away.
   */
  putActionCard(adId: string, actionCard: ActionCard): Promise<AdDetail> {
    return this.stationScopedTransaction.run(async (database) => {
      const ad = await lockAndFindAdRecord(database, adId);
      const [savedCard] = (await database.query(
        `INSERT INTO app.action_cards (station_id, client_id, schema_version, content, created_by_portal_user_id)
         VALUES (app.current_station_id(), $1, $2, $3::jsonb, app.current_user_id())
         RETURNING id`,
        [ad.client_id, actionCard.schema_version, JSON.stringify(actionCard)],
      )) as Array<{ id: string }>;
      const actionCardId = (savedCard as { id: string }).id;
      await database.query(`UPDATE app.ads SET current_action_card_id = $2 WHERE id = $1`, [adId, actionCardId]);
      await database.query(`UPDATE app.campaigns SET action_card_id = $2 WHERE ad_id = $1 AND status IN ('ACTIVE', 'PAUSED')`, [
        adId,
        actionCardId,
      ]);
      // Phone numbers and links stay in the card versions; the audit row says which fields changed.
      await this.auditTrail.record(database, {
        action: 'action_card_saved',
        entityType: 'action_card',
        entityId: actionCardId,
        changes: {
          adId,
          previousActionCardId: ad.current_action_card_id,
          changedFields: describeActionCardChanges(ad.action_card_content, actionCard),
        },
      });
      return toAdDetail(await findAdRecord(database, adId));
    });
  }
}
