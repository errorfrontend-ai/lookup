import { z } from 'zod';

/**
 * Password rules (NIST SP 800-63B revision 4, single-factor passwords): at least 15 and at most 128
 * characters, counted as Unicode code points after NFC normalisation. No composition rules, no
 * expiry; the API also refuses common passwords and passwords containing personal details.
 */
export const PASSWORD_MINIMUM_LENGTH = 15;
export const PASSWORD_MAXIMUM_LENGTH = 128;

/** Characters as a person sees them: NFC-normalised, one per Unicode code point. */
export function countPasswordCharacters(password: string): number {
  return Array.from(password.normalize('NFC')).length;
}

// Upper bounds on raw input size only; the policy itself is checked in characters by the API.
const PasswordInput = z.string().min(1).max(1024);

export const SignInInput = z.strictObject({
  email: z.string().trim().min(3).max(254),
  password: PasswordInput,
});
export type SignInInput = z.infer<typeof SignInInput>;

export const ChangePasswordInput = z.strictObject({
  currentPassword: PasswordInput,
  newPassword: PasswordInput,
});
export type ChangePasswordInput = z.infer<typeof ChangePasswordInput>;

export const STATION_ROLES = ['OWNER', 'MANAGER', 'ANALYST'] as const;
export type StationRole = (typeof STATION_ROLES)[number];

export const STATION_STATUSES = ['PENDING_VERIFICATION', 'PENDING_REVIEW', 'ACTIVE', 'REJECTED', 'SUSPENDED'] as const;
export type StationStatus = (typeof STATION_STATUSES)[number];

/** What the portal learns about the signed-in person (GET /auth/me and POST /auth/sign-in). */
export interface SignedInPortalUser {
  user: { id: string; fullName: string; email: string };
  stations: Array<{ id: string; name: string; frequencyLabel: string; status: StationStatus; role: StationRole }>;
}
