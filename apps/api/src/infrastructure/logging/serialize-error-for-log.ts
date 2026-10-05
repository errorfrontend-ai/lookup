import { scrubPersonalData } from '../../common/privacy/scrub-personal-data.js';

/**
 * How an error is written to the private log.
 *
 * pino's standard serializer copies every enumerable field of an error, and database errors carry
 * the values that were sent: TypeORM's QueryFailedError keeps the bound `parameters` (emails,
 * password hashes, card JSON with phone numbers), and the Postgres driver's `detail` repeats key
 * values or the whole failing row. Some Postgres messages also end by quoting the rejected value
 * (`invalid input syntax for type uuid: "…"`).
 *
 * This keeps what diagnoses a failure — type, message, stack, SQLSTATE, constraint, table, column,
 * the SQL text with its $1 placeholders, and the cause chain — and drops or masks the values.
 */
export interface LoggedError {
  type: string;
  message: string;
  stack?: string;
  code?: string;
  constraint?: string;
  table?: string;
  column?: string;
  schema?: string;
  routine?: string;
  query?: string;
  cause?: LoggedError;
}

/** Fields of a Postgres error that name things in our schema, never values. */
const DATABASE_NAME_FIELDS = ['constraint', 'table', 'column', 'schema', 'routine'] as const;
const MAXIMUM_CAUSE_DEPTH = 3;
const MAXIMUM_QUERY_LENGTH = 2_000;

export function serializeErrorForLog(loggedValue: unknown, depth = 0): LoggedError {
  const value = originalError(loggedValue);
  if (!(value instanceof Error)) {
    return { type: typeof value, message: scrubPersonalData(String(value)) };
  }
  const fields = value as Error & Record<string, unknown>;
  // TypeORM wraps the driver's error; its schema names live on the inner one.
  const driverError = (fields.driverError ?? fields) as Record<string, unknown>;
  const sqlState = asString(driverError.code) ?? asString(fields.code);
  const isDatabaseError = sqlState !== undefined && /^[0-9A-Z]{5}$/.test(sqlState);

  const message = cleanMessage(value.message, isDatabaseError);
  const logged: LoggedError = { type: value.constructor?.name || value.name, message };
  if (value.stack) logged.stack = cleanStack(value, message, isDatabaseError);
  if (sqlState) logged.code = sqlState;
  if (isDatabaseError) {
    for (const name of DATABASE_NAME_FIELDS) {
      const text = asString(driverError[name]);
      if (text) logged[name] = text;
    }
  }
  const query = asString(fields.query);
  if (query) logged.query = scrubPersonalData(query.slice(0, MAXIMUM_QUERY_LENGTH));
  if (value.cause !== undefined && depth < MAXIMUM_CAUSE_DEPTH) logged.cause = serializeErrorForLog(value.cause, depth + 1);
  return logged;
}

/**
 * pino-http runs pino's standard error serializer first and hands us its result, which already
 * holds every enumerable field (parameters included) and the causes' messages merged into one.
 * It keeps the original error on a hidden `raw` property; we start again from that.
 */
function originalError(loggedValue: unknown): unknown {
  if (typeof loggedValue === 'object' && loggedValue !== null && !(loggedValue instanceof Error) && 'raw' in loggedValue) {
    return (loggedValue as { raw: unknown }).raw;
  }
  return loggedValue;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Postgres puts a rejected input value at the end of the message, after a colon and in quotes. */
function cleanMessage(message: string, isDatabaseError: boolean): string {
  const withoutQuotedValue = isDatabaseError ? message.replace(/: ".*"$/s, ': [value removed]') : message;
  return scrubPersonalData(withoutQuotedValue);
}

/** A stack starts by repeating "Type: message"; that copy gets the same cleaning as the message. */
function cleanStack(error: Error, cleanedMessage: string, isDatabaseError: boolean): string {
  const stack = error.stack as string;
  const header = `${error.name}: ${error.message}`;
  const cleaned = isDatabaseError && stack.startsWith(header) ? `${error.name}: ${cleanedMessage}${stack.slice(header.length)}` : stack;
  return scrubPersonalData(cleaned);
}
