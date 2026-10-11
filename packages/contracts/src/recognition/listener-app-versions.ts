/**
 * The listener app's version as it registers it (`app_version` of POST /api/v1/installs): major, minor
 * and patch, and optionally a build number after "+", as Flutter writes it ("0.1.0+12"). Only plain
 * ASCII digits; anything else (a pre-release such as "1.0.0-beta", spaces, a missing part) cannot be
 * compared.
 */
const LISTENER_APP_VERSION = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:\+(\d{1,9}))?$/;

/** The minimum that turns the update gate off: every version, even one that cannot be read, may call. */
export const NO_MINIMUM_APP_VERSION = '0.0.0';

export type VersionComparison = -1 | 0 | 1;

/** The four numbers of a version, a missing build counting as 0; null when the version cannot be read. */
function readListenerAppVersion(version: string): [number, number, number, number] | null {
  const parts = LISTENER_APP_VERSION.exec(version);
  if (!parts) return null;
  return [Number(parts[1]), Number(parts[2]), Number(parts[3]), Number(parts[4] ?? '0')];
}

/** Whether the version can be compared, as LISTENER_MINIMUM_APP_VERSION must be. */
export function isListenerAppVersion(version: string): boolean {
  return readListenerAppVersion(version) !== null;
}

/**
 * Compares two app versions by major, minor, patch, then build: -1 when the first is older, 0 when
 * they are the same version ("1.0.0" and "1.0.0+0" are), 1 when the first is newer. Null when either
 * cannot be read. `fixtures/recognition/listener-app-versions/comparisons.json` holds the cases.
 */
export function compareListenerAppVersions(first: string, second: string): VersionComparison | null {
  const firstNumbers = readListenerAppVersion(first);
  const secondNumbers = readListenerAppVersion(second);
  if (!firstNumbers || !secondNumbers) return null;
  for (let position = 0; position < firstNumbers.length; position += 1) {
    const difference = (firstNumbers[position] as number) - (secondNumbers[position] as number);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * The update gate (426 APP_UPDATE_REQUIRED): the version the install registered with is older than
 * the minimum, or cannot be read while a minimum is set. With the minimum at "0.0.0" the gate is off.
 */
export function isBelowMinimumAppVersion(registeredVersion: string, minimumVersion: string): boolean {
  const comparison = compareListenerAppVersions(registeredVersion, minimumVersion);
  if (comparison === null) return minimumVersion !== NO_MINIMUM_APP_VERSION;
  return comparison === -1;
}
