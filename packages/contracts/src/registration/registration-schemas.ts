import { z } from 'zod';
import type { StationStatus } from '../authentication/authentication-schemas.js';
import { normalizeZambianPhoneInput } from '../phone-numbers/zambian-phone-numbers.js';
import { MAXIMUM_CITY_LENGTH, ZAMBIAN_PROVINCES } from '../stations/station-schemas.js';
import type { LicenceDocumentSummary } from './station-upload-schemas.js';

/**
 * Station sign-up (design docs/design/step-5a-registration-and-admin.md §3.3, §4.2). Four steps:
 * "Your account", "Verify", "Station details" and "Licence". Step 1 creates the account and the
 * station and signs the applicant in; every later step saves to the server, so the applicant can stop
 * and come back from any device.
 */

/** Rules a sign-up answer must follow that a JSON shape can't express; relayed as field reason codes. */
export const REGISTRATION_RULE_REASONS = [
  'not_a_zambian_mobile_number',
  'not_https',
  'unknown_time_zone',
  'phone_not_verified',
  'email_not_verified',
  'station_details_missing',
  'licence_number_missing',
  'licence_document_missing',
  'nothing_changed',
] as const;
export type RegistrationRuleReason = (typeof REGISTRATION_RULE_REASONS)[number];

export const MAXIMUM_FULL_NAME_LENGTH = 120;
export const MAXIMUM_EMAIL_LENGTH = 254;
export const MAXIMUM_STATION_NAME_LENGTH = 120;
export const MAXIMUM_FREQUENCY_LABEL_LENGTH = 32;
export const MAXIMUM_COVERAGE_NOTE_LENGTH = 300;
export const MAXIMUM_STREAM_ADDRESS_LENGTH = 500;
export const MAXIMUM_LICENCE_NUMBER_LENGTH = 60;
/** Cloudflare Turnstile tokens are at most 2,048 characters. */
export const MAXIMUM_HUMAN_CHECK_TOKEN_LENGTH = 2048;
/** The time zone a new station starts with (plan G6). */
export const DEFAULT_STATION_TIME_ZONE = 'Africa/Lusaka';

/** How long a phone code lasts and how soon another may be sent (plan §A step 2). */
export const PHONE_CODE_LIFETIME_SECONDS = 10 * 60;
export const PHONE_CODE_RESEND_COOLDOWN_SECONDS = 60;
export const PHONE_CODE_ATTEMPT_LIMIT = 5;
/** How long an email link lasts (NIST SP 800-63B-4 §4.2.2: 24 hours for a code sent by email). */
export const EMAIL_LINK_LIFETIME_HOURS = 24;
/** What the sign-up and status pages promise (gap 7; the wireframes' placeholder). */
export const APPLICATION_REVIEW_TIME_TEXT = '2 working days';

export const FullName = z.string().trim().min(1).max(MAXIMUM_FULL_NAME_LENGTH);
export const EmailAddress = z.string().trim().max(MAXIMUM_EMAIL_LENGTH).pipe(z.email());

/** A Zambian mobile number as typed ("97 123 4567", "0977 123 456", "+260…"), stored as E.164. */
export const ZambianMobileNumber = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .transform((typed, context) => {
    const normalized = normalizeZambianPhoneInput(typed);
    if (normalized === null || !normalized.startsWith('+260')) {
      context.addIssue({ code: 'custom', params: { reason: 'not_a_zambian_mobile_number' }, message: 'not_a_zambian_mobile_number' });
      return z.NEVER;
    }
    return normalized;
  });

// Upper bound on raw input size only; the password policy itself is checked by the API.
const NewPassword = z.string().min(1).max(1024);

/** A single-use token from a link (32 random bytes, base64url): email links and invitations. */
export const LinkToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** POST /registration/applicants — step 1. */
export const RegisterStationApplicantInput = z.strictObject({
  fullName: FullName,
  email: EmailAddress,
  mobileNumber: ZambianMobileNumber,
  password: NewPassword,
  humanCheckToken: z.string().min(1).max(MAXIMUM_HUMAN_CHECK_TOKEN_LENGTH),
});
export type RegisterStationApplicantInput = z.input<typeof RegisterStationApplicantInput>;

/** PUT /stations/{stationId}/application/account — step 1 changed later (no password, no human check). */
export const ChangeApplicantAccountInput = z.strictObject({
  fullName: FullName,
  email: EmailAddress,
  mobileNumber: ZambianMobileNumber,
});
export type ChangeApplicantAccountInput = z.input<typeof ChangeApplicantAccountInput>;

/** A 6-digit code, leading zeros kept: the SMS code and the super admin's authenticator code. */
export const SixDigitCode = z.string().regex(/^[0-9]{6}$/);

/** POST /stations/{stationId}/application/phone-verification */
export const CheckPhoneVerificationCodeInput = z.strictObject({ code: SixDigitCode });
export type CheckPhoneVerificationCodeInput = z.infer<typeof CheckPhoneVerificationCodeInput>;

/** POST /registration/email-verifications — the link's token, from any device. */
export const ConfirmEmailVerificationInput = z.strictObject({ token: LinkToken });
export type ConfirmEmailVerificationInput = z.infer<typeof ConfirmEmailVerificationInput>;

export const StationName = z.string().trim().min(1).max(MAXIMUM_STATION_NAME_LENGTH);
export const FrequencyLabel = z.string().trim().min(1).max(MAXIMUM_FREQUENCY_LABEL_LENGTH);
export const LicenceNumber = z.string().trim().min(1).max(MAXIMUM_LICENCE_NUMBER_LENGTH);

/** An optional https address for the station's live stream (stored for phase 9). */
const StreamAddress = z
  .string()
  .trim()
  .min(1)
  .max(MAXIMUM_STREAM_ADDRESS_LENGTH)
  .superRefine((address, context) => {
    let parsed: URL | null = null;
    try {
      parsed = new URL(address);
    } catch {
      parsed = null;
    }
    if (parsed === null || parsed.protocol !== 'https:' || parsed.hostname === '') {
      context.addIssue({ code: 'custom', params: { reason: 'not_https' }, message: 'not_https' });
    }
  });

/** An IANA time-zone name; the API checks it against the database's list. */
const TimeZoneName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_+\-/]+$/);

/** PUT /stations/{stationId}/application/details — step 3. */
export const SaveStationApplicationDetailsInput = z.strictObject({
  name: StationName,
  frequencyLabel: FrequencyLabel,
  province: z.enum(ZAMBIAN_PROVINCES),
  city: z.string().trim().min(1).max(MAXIMUM_CITY_LENGTH),
  timeZone: TimeZoneName,
  coverageNote: z.string().trim().min(1).max(MAXIMUM_COVERAGE_NOTE_LENGTH).nullable(),
  streamAddress: StreamAddress.nullable(),
});
export type SaveStationApplicationDetailsInput = z.infer<typeof SaveStationApplicationDetailsInput>;

/** PUT /stations/{stationId}/application/licence — step 4's number. */
export const SaveStationLicenceInput = z.strictObject({ licenceNumber: LicenceNumber });
export type SaveStationLicenceInput = z.infer<typeof SaveStationLicenceInput>;

/** POST /stations/{stationId}/application/submission */
export const SubmitStationApplicationInput = z.strictObject({ isLicenceConfirmed: z.literal(true) });
export type SubmitStationApplicationInput = z.infer<typeof SubmitStationApplicationInput>;

/** The sign-up steps in order; "submitted" once the application is with the review team. */
export const APPLICATION_STEPS = ['account', 'verify', 'details', 'licence'] as const;
export type ApplicationStep = (typeof APPLICATION_STEPS)[number];

/** GET /stations/{stationId}/application — everything the applicant has saved so far. */
export interface StationApplication {
  stationId: string;
  status: StationStatus;
  account: { fullName: string; email: string; mobileNumber: string | null };
  verification: {
    isPhoneVerified: boolean;
    isEmailVerified: boolean;
    /** When the last phone code was sent, and when another may be sent (null when none was sent). */
    phoneCodeSentAt: string | null;
    phoneCodeResendAvailableAt: string | null;
  };
  details: {
    name: string | null;
    frequencyLabel: string | null;
    province: string | null;
    city: string | null;
    timeZone: string;
    coverageNote: string | null;
    streamAddress: string | null;
    /** A short-lived address for the processed logo, or null when there is none. */
    logoAddress: string | null;
  };
  licence: { licenceNumber: string | null; document: LicenceDocumentSummary | null; confirmedAt: string | null };
  submittedAt: string | null;
  reviewedAt: string | null;
  /** The reviewer's reason, word for word, only while the application is rejected. */
  rejectionReason: string | null;
  /** The first step with something missing, or "submitted" once it is with the review team. */
  nextStep: ApplicationStep | 'submitted';
}

/** What step 1 answers: the signed-in person and their new station's id. */
export interface RegisteredStationApplicant {
  stationId: string;
}

/** POST /stations/{stationId}/change-requests — an approved station asks to change what the review team checked (O2). */
export const RequestStationDetailChangeInput = z.strictObject({
  name: StationName,
  frequencyLabel: FrequencyLabel,
  licenceNumber: LicenceNumber,
  licenceDocumentUploadId: z.uuid().nullable(),
});
export type RequestStationDetailChangeInput = z.infer<typeof RequestStationDetailChangeInput>;

export const CHANGE_REQUEST_DECISIONS = ['APPROVED', 'REJECTED', 'WITHDRAWN'] as const;
export type ChangeRequestDecision = (typeof CHANGE_REQUEST_DECISIONS)[number];

export interface StationChangeRequest {
  id: string;
  requestedAt: string;
  name: string;
  frequencyLabel: string;
  licenceNumber: string;
  hasNewLicenceDocument: boolean;
  decision: ChangeRequestDecision | null;
  decisionNote: string | null;
  decidedAt: string | null;
}

/** GET /stations/{stationId}/change-request — the approved details and any change waiting or last decided. */
export interface StationChangeRequestState {
  approved: { name: string; frequencyLabel: string; licenceNumber: string | null };
  open: StationChangeRequest | null;
  lastDecided: StationChangeRequest | null;
}
