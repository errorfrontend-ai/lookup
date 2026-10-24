import { z } from 'zod';

/**
 * An email address as every portal form takes it. In a file of its own, importing nothing else of the contracts, so the
 * station and registration contracts (which import each other's constants) can both use it.
 */
export const MAXIMUM_EMAIL_LENGTH = 254;
export const EmailAddress = z.string().trim().max(MAXIMUM_EMAIL_LENGTH).pipe(z.email());
