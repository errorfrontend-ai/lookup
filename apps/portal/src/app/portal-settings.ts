/**
 * Cloudflare's published Turnstile test site key that always passes (P5A-D8): development and tests. A build for
 * production sets VITE_HUMAN_CHECK_SITE_KEY to the real one; the API refuses the test secret in production anyway.
 */
export const TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA';

export const HUMAN_CHECK_SITE_KEY: string = (import.meta.env.VITE_HUMAN_CHECK_SITE_KEY as string | undefined) || TURNSTILE_TEST_SITE_KEY;
