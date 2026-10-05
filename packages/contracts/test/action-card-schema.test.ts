import { describe, expect, it } from 'vitest';
import { ActionCard } from '../src/action-card/action-card-schema.js';
import { isUrlShortenerHost } from '../src/action-card/url-shortener-hosts.js';
import { type ExpectedIssue, readFixtureFolder } from './fixtures.js';

interface ValidCardFixture {
  description: string;
  card: unknown;
}
interface InvalidCardFixture extends ValidCardFixture {
  zod_only: boolean;
  expected_issues: ExpectedIssue[];
}

/** Issues as the fixtures record them: the field path, and the code (custom rules carry their reason). */
function issuesOf(card: unknown): ExpectedIssue[] {
  const result = ActionCard.safeParse(card);
  if (result.success) return [];
  return result.error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    code: issue.code === 'custom' ? `custom:${(issue as { params?: { reason?: string } }).params?.reason}` : issue.code,
  }));
}

describe('action card schema', () => {
  const validFixtures = readFixtureFolder<ValidCardFixture>('action-card/valid');
  const invalidFixtures = readFixtureFolder<InvalidCardFixture>('action-card/invalid');

  it('has fixtures to check', () => {
    expect(validFixtures.length).toBeGreaterThanOrEqual(13);
    expect(invalidFixtures.length).toBeGreaterThanOrEqual(38);
  });

  it.each(validFixtures.map(({ name, fixture }) => [name, fixture] as const))('accepts %s', (_name, fixture) => {
    expect(issuesOf(fixture.card)).toEqual([]);
  });

  // Asserting the exact path and code proves each case fails for the reason it was written for.
  it.each(invalidFixtures.map(({ name, fixture }) => [name, fixture] as const))(
    'refuses %s for the expected reason',
    (_name, fixture) => {
      expect(issuesOf(fixture.card)).toEqual(fixture.expected_issues);
    },
  );
});

describe('link shorteners', () => {
  it.each([
    ['bit.ly', true],
    ['www.bit.ly', true],
    ['BIT.LY', true],
    ['tinyurl.com.', true],
    ['notbit.ly', false],
    ['bit.ly.example.com', false],
    ['example.co.zm', false],
  ])('%s is a shortener: %s', (hostname, expected) => {
    expect(isUrlShortenerHost(hostname)).toBe(expected);
  });
});
