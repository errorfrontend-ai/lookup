import { z } from 'zod';

/**
 * A crash or failure a client (the portal or the listener app) reports, so client errors reach the
 * developers instead of staying on one person's screen. Text is scrubbed by the API before logging.
 */
export const ClientErrorReport = z.strictObject({
  source: z.enum(['portal', 'listener-app']),
  /** render = a screen failed to draw; uncaught = an error nothing caught; unhandled-rejection = a failed promise nobody awaited. */
  kind: z.enum(['render', 'uncaught', 'unhandled-rejection', 'reported']),
  message: z.string().min(1).max(500),
  stack: z.string().max(8000).optional(),
  /** The screen's path only (no query string). */
  location: z.string().max(300).optional(),
  /** The API request that failed, when there was one, so the two log lines can be joined. */
  relatedRequestId: z.uuid().optional(),
  appVersion: z.string().max(40).optional(),
});
export type ClientErrorReport = z.infer<typeof ClientErrorReport>;
