import { QueryFailedError } from 'typeorm';

/**
 * True when `error` is Postgres refusing a duplicate on the named unique constraint (SQLSTATE 23505).
 * Lets a feature turn one specific, expected conflict into a message written for the user, while
 * every other database error still becomes a generic 500.
 */
export function isUniqueViolation(error: unknown, constraintName: string): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const driverError = error.driverError as { code?: unknown; constraint?: unknown } | undefined;
  return driverError?.code === '23505' && driverError.constraint === constraintName;
}

/** True when `error` is Postgres refusing a value that breaks the named check constraint (SQLSTATE 23514). */
export function isCheckViolation(error: unknown, constraintName?: string): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const driverError = error.driverError as { code?: unknown; constraint?: unknown } | undefined;
  return driverError?.code === '23514' && (constraintName === undefined || driverError.constraint === constraintName);
}
