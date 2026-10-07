const AD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a value from the address bar is an ad id at all. Anything else is "not found" and never goes
 * into an API path, where an encoded "/" or "?" could point the portal's request at another address.
 */
export function isAdId(value: string | undefined): value is string {
  return value !== undefined && AD_ID.test(value);
}
