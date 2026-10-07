import { describe, expect, it } from 'vitest';
import { adDetail } from '../../test/ad-fixtures';
import { newerAdDetail } from './use-ad-detail';

describe('which of two versions of an ad to keep', () => {
  const at = (iso: string) => adDetail({ id: '0190f1a2-0000-7000-8000-0000000000ad', updatedAt: iso });

  it('keeps the version already held when a refresh brings back an older one (sent before a save, arriving after it)', () => {
    const saved = at('2026-10-07T10:00:05.000Z');
    const stale = at('2026-10-07T10:00:01.000Z');
    expect(newerAdDetail(stale, saved)).toBe(saved);
  });

  it('takes the refresh when it is newer (a change made elsewhere) or the same age', () => {
    const held = at('2026-10-07T10:00:01.000Z');
    const newer = at('2026-10-07T10:00:09.000Z');
    expect(newerAdDetail(newer, held)).toBe(newer);
    const sameAge = at('2026-10-07T10:00:01.000Z');
    expect(newerAdDetail(sameAge, held)).toBe(sameAge);
  });

  it('takes the refresh when nothing is held yet', () => {
    const fetched = at('2026-10-07T10:00:01.000Z');
    expect(newerAdDetail(fetched, undefined)).toBe(fetched);
  });
});
