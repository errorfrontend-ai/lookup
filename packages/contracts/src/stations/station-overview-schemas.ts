import type { AdSummary } from '../ads/ad-schemas.js';
import type { AdListViewCounts } from '../ads/ad-list-schemas.js';

/** The most ads the overview lists under "Live now" and "Needs attention". */
export const OVERVIEW_LIVE_NOW_LIMIT = 10;
export const OVERVIEW_ATTENTION_LIMIT = 5;

/** GET /stations/{stationId}/overview */
export interface StationOverview {
  adCounts: AdListViewCounts;
  /** Ads on air right now, A to Z. */
  liveNowAds: AdSummary[];
  /** The most serious problems first, then the most recently changed. */
  attentionAds: AdSummary[];
}
