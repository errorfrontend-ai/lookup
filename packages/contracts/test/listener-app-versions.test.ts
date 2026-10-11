import { describe, expect, it } from 'vitest';
import {
  compareListenerAppVersions,
  isBelowMinimumAppVersion,
  isListenerAppVersion,
  NO_MINIMUM_APP_VERSION,
  type VersionComparison,
} from '../src/recognition/listener-app-versions.js';
import { readFixtureFile } from './fixtures.js';

interface ComparisonsFixture {
  description: string;
  comparisons: Array<{ description: string; first: string; second: string; expected: VersionComparison | null }>;
}

/** The update gate compares the version an install registered with to LISTENER_MINIMUM_APP_VERSION. */
describe('listener app versions', () => {
  const { comparisons } = readFixtureFile<ComparisonsFixture>('recognition/listener-app-versions/comparisons.json');

  it('has the cases the contract names, and unreadable ones', () => {
    const has = (first: string, second: string, expected: VersionComparison | null) =>
      comparisons.some((row) => row.first === first && row.second === second && row.expected === expected);
    expect(has('0.1.0+1', '0.1.0+2', -1) && has('0.1.0+2', '0.2.0', -1) && has('1.0.0', '1.0.0+0', 0)).toBe(true);
    expect(comparisons.filter((row) => row.expected === null).length).toBeGreaterThanOrEqual(5);
  });

  it.each(comparisons.map((row) => [row.first, row.second, row.expected, row.description] as const))(
    'compares "%s" with "%s" as %s: %s',
    (first, second, expected) => {
      expect(compareListenerAppVersions(first, second)).toBe(expected);
    },
  );

  it.each(comparisons.map((row) => [row.first, row.second, row.expected] as const))('the other way round, "%s" and "%s" compare the opposite way', (first, second, expected) => {
    // 0 - expected, not -expected, so that 0 stays 0 rather than -0.
    expect(compareListenerAppVersions(second, first)).toBe(expected === null ? null : 0 - expected);
  });

  it('a version can be read exactly when it compares with itself', () => {
    for (const { first, second } of comparisons) {
      for (const version of [first, second]) expect(isListenerAppVersion(version), version).toBe(compareListenerAppVersions(version, version) === 0);
    }
  });

  it('the gate refuses a version below the minimum, or one it cannot read while a minimum is set', () => {
    expect(isBelowMinimumAppVersion('0.1.0+1', '0.2.0')).toBe(true);
    expect(isBelowMinimumAppVersion('0.2.0', '0.2.0')).toBe(false);
    expect(isBelowMinimumAppVersion('0.2.0+0', '0.2.0')).toBe(false);
    expect(isBelowMinimumAppVersion('0.3.0', '0.2.0')).toBe(false);
    expect(isBelowMinimumAppVersion('1.0.0-beta', '0.2.0')).toBe(true);
  });

  it('with the minimum at 0.0.0 the gate is off: every version may call, even one it cannot read', () => {
    expect(NO_MINIMUM_APP_VERSION).toBe('0.0.0');
    for (const registered of ['0.0.0', '0.1.0+1', '1.0.0-beta', 'not-a-version', '']) {
      expect(isBelowMinimumAppVersion(registered, NO_MINIMUM_APP_VERSION), registered).toBe(false);
    }
  });
});
