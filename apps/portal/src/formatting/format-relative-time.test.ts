import { describe, expect, it } from 'vitest';
import { formatRelativeTime } from './format-relative-time';

const now = new Date('2026-10-06T12:00:00Z');

describe('formatRelativeTime', () => {
  it.each([
    ['2026-10-06T11:59:40Z', 'just now'],
    ['2026-10-06T11:55:00Z', '5 min ago'],
    ['2026-10-06T11:00:00Z', '1 hour ago'],
    ['2026-10-06T07:00:00Z', '5 hours ago'],
    ['2026-10-05T10:00:00Z', 'yesterday'],
    ['2026-10-03T12:00:00Z', '3 days ago'],
    ['2026-09-10T12:00:00Z', '10 Sep'],
    ['2025-12-24T12:00:00Z', '24 Dec 2025'],
  ])('%s reads %s', (when, expected) => {
    expect(formatRelativeTime(when, now)).toBe(expected);
  });

  it('gives nothing for text that is not a date', () => {
    expect(formatRelativeTime('not a date', now)).toBe('');
  });
});
