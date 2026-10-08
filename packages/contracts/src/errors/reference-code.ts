/** A request id as the API gives one: a UUID of version 1 to 8, the same rule the API applies to X-Request-Id. */
const REQUEST_ID_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The reference code a listener reads out to support (S4-D9): the first 8 hex digits of the API's
 * request id, upper case, as XXXX-XXXX, e.g. "6f1c2d3e-…" gives "6F1C-2D3E". Support finds the log
 * line by searching for a requestId that starts with those 8 digits in lower case. Anything that is
 * not a request id the API could have logged gives null, so no code is ever shown that support
 * cannot find.
 */
export function referenceCodeForRequestId(requestId: string): string | null {
  if (!REQUEST_ID_UUID.test(requestId)) return null;
  const firstEightDigits = requestId.slice(0, 8).toUpperCase();
  return `${firstEightDigits.slice(0, 4)}-${firstEightDigits.slice(4)}`;
}
