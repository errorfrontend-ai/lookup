import type { AdDetail } from '@lookup/contracts';

const FIVE_SECONDS = 5_000;
const FIFTEEN_SECONDS = 15_000;
const ONE_MINUTE = 60_000;
const TWO_MINUTES = 2 * 60_000;
const TEN_MINUTES = 10 * 60_000;

/**
 * How soon an ad's page asks the server for news, in milliseconds, or false for "not until the person
 * does something". An ad whose audio is still being received or prepared is checked every few seconds
 * at first, then less often (in this version preparing never finishes by itself, so it settles at once
 * a minute). A published ad is checked once a minute so its ON AIR badge stays true. Anything else
 * only changes when the person changes it.
 */
export function chooseAdRefreshInterval(ad: Pick<AdDetail, 'status' | 'campaign' | 'uploadedAt' | 'updatedAt'>, now: Date = new Date()): number | false {
  if (ad.status === 'AWAITING_UPLOAD' || ad.status === 'PROCESSING') {
    const startedAt = new Date(ad.uploadedAt ?? ad.updatedAt).getTime();
    const age = Number.isNaN(startedAt) ? 0 : now.getTime() - startedAt;
    if (age < TWO_MINUTES) return FIVE_SECONDS;
    if (age < TEN_MINUTES) return FIFTEEN_SECONDS;
    return ONE_MINUTE;
  }
  const displayStatus = ad.campaign?.displayStatus;
  return displayStatus === 'SCHEDULED' || displayStatus === 'LIVE_NOW' ? ONE_MINUTE : false;
}
