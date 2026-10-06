import { OVERVIEW_ATTENTION_LIMIT, OVERVIEW_LIVE_NOW_LIMIT, type StationOverview } from '@lookup/contracts';
import { Injectable } from '@nestjs/common';
import { StationScopedTransaction } from '../../infrastructure/database/station-scoped-transaction.js';
import {
  AD_LIST_VIEW_CONDITIONS,
  AD_LIST_VIEW_COUNT_COLUMNS,
  ATTENTION_SEVERITY_ORDER,
  LISTED_ADS_CTE,
  toAdListViewCounts,
} from '../ads/ad-list-query.js';
import { type AdRecord, toAdSummary } from '../ads/ad-records.js';

/** What the station's front page shows: how many ads fall under each tab, what is on air, what needs attention. */
@Injectable()
export class StationOverviewService {
  constructor(private readonly stationScopedTransaction: StationScopedTransaction) {}

  read(): Promise<StationOverview> {
    return this.stationScopedTransaction.run(async (database) => {
      const [countRow] = (await database.query(`${LISTED_ADS_CTE} SELECT ${AD_LIST_VIEW_COUNT_COLUMNS} FROM listed`)) as Array<
        Record<string, number>
      >;
      const liveNowRows = (await database.query(
        `${LISTED_ADS_CTE}
         SELECT listed.* FROM listed WHERE ${AD_LIST_VIEW_CONDITIONS.live}
          ORDER BY lower(listed.title), listed.id LIMIT ${OVERVIEW_LIVE_NOW_LIMIT}`,
      )) as AdRecord[];
      const attentionRows = (await database.query(
        `${LISTED_ADS_CTE}
         SELECT listed.* FROM listed WHERE ${AD_LIST_VIEW_CONDITIONS.attention}
          ORDER BY ${ATTENTION_SEVERITY_ORDER}, listed.last_changed_at DESC, listed.id DESC LIMIT ${OVERVIEW_ATTENTION_LIMIT}`,
      )) as AdRecord[];
      return {
        adCounts: toAdListViewCounts(countRow ?? {}),
        liveNowAds: liveNowRows.map(toAdSummary),
        attentionAds: attentionRows.map(toAdSummary),
      };
    });
  }
}
