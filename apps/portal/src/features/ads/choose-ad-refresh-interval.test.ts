import type { AdDetail } from '@lookup/contracts';
import { describe, expect, it } from 'vitest';
import { adDetail, campaignSummary } from '../../test/ad-fixtures';
import { chooseAdRefreshInterval } from './choose-ad-refresh-interval';

const now = new Date('2026-10-06T12:00:00Z');
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
const ad = (overrides: Partial<AdDetail>) => adDetail({ uploadedAt: null, ...overrides });

describe('chooseAdRefreshInterval', () => {
  it('checks an ad whose audio is still being received every 5 seconds at first, then less often, settling at once a minute', () => {
    expect(chooseAdRefreshInterval(ad({ status: 'AWAITING_UPLOAD', updatedAt: minutesAgo(1) }), now)).toBe(5_000);
    expect(chooseAdRefreshInterval(ad({ status: 'PROCESSING', uploadedAt: minutesAgo(1) }), now)).toBe(5_000);
    expect(chooseAdRefreshInterval(ad({ status: 'PROCESSING', uploadedAt: minutesAgo(5) }), now)).toBe(15_000);
    expect(chooseAdRefreshInterval(ad({ status: 'PROCESSING', uploadedAt: minutesAgo(30) }), now)).toBe(60_000);
    expect(chooseAdRefreshInterval(ad({ status: 'PROCESSING', uploadedAt: minutesAgo(60 * 24 * 3) }), now)).toBe(60_000);
  });

  it('checks a published ad once a minute, so its ON AIR badge stays true', () => {
    for (const displayStatus of ['SCHEDULED', 'LIVE_NOW'] as const) {
      expect(chooseAdRefreshInterval(ad({ status: 'READY', campaign: campaignSummary({ displayStatus }) }), now), displayStatus).toBe(60_000);
    }
  });

  it('does not check an ad that only changes when the person changes it', () => {
    for (const displayStatus of ['DRAFT', 'ENDED', 'PAUSED'] as const) {
      expect(chooseAdRefreshInterval(ad({ status: 'READY', campaign: campaignSummary({ displayStatus }) }), now), displayStatus).toBe(false);
    }
    expect(chooseAdRefreshInterval(ad({ status: 'READY', campaign: null }), now)).toBe(false);
    expect(chooseAdRefreshInterval(ad({ status: 'FAILED', campaign: null }), now)).toBe(false);
  });

  it('copes with a date it cannot read', () => {
    expect(chooseAdRefreshInterval(ad({ status: 'PROCESSING', uploadedAt: 'not a date', updatedAt: 'also not' }), now)).toBe(5_000);
  });
});
