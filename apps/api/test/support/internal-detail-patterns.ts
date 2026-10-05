import { ErrorEnvelope } from '@lookup/contracts';

/**
 * Text that must never appear in a public response: exception class names, SQL state codes and
 * driver wording, file paths, stack frames, Python tracebacks, PHP-style fatal errors, and the JSON
 * parser's own messages.
 */
export const INTERNAL_DETAIL_PATTERNS = [
  /QueryFailedError|DatabaseError|TypeError|SyntaxError|ReferenceError|HttpException|Exception\b/,
  /SQLSTATE|duplicate key|violates|constraint|relation "|syntax error/i,
  /23505|22P02|42501|42P01/,
  /node_modules|[A-Za-z]:\\|\/app\/|\/src\/|\.ts:\d+|\.js:\d+/,
  /at \S+ \(|\n\s+at /,
  /Traceback \(most recent call last\)|Traceback/,
  /Fatal error/i,
  // V8's JSON.parse wording, which body-parser puts in its error message.
  /Unexpected (token|end of JSON)|in JSON at position|" is not valid JSON|Expected property name/,
];

export function assertNoInternalDetails(responseBody: unknown): void {
  const text = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody);
  for (const pattern of INTERNAL_DETAIL_PATTERNS) {
    if (pattern.test(text)) throw new Error(`Response exposes internal detail (${pattern}): ${text}`);
  }
}

/** The body is exactly the shared error envelope (no extra keys anywhere) and leaks nothing technical. */
export function assertErrorEnvelope(responseBody: unknown): ErrorEnvelope {
  const parsed = ErrorEnvelope.safeParse(responseBody);
  if (!parsed.success) throw new Error(`Response is not the error envelope: ${JSON.stringify(responseBody)}`);
  assertNoInternalDetails(responseBody);
  return parsed.data;
}
