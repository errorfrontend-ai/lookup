import type { StationApplication } from '@lookup/contracts';

/** The station of the sign-up tests: the first station signedInUserWith makes. */
export const APPLICANT_STATION_ID = '0190f1a2-0000-7000-8000-000000000100';
const STATION_ID = APPLICANT_STATION_ID;

export type ApplicationChanges = Omit<Partial<StationApplication>, 'verification' | 'details' | 'licence'> & {
  verification?: Partial<StationApplication['verification']>;
  details?: Partial<StationApplication['details']>;
  licence?: Partial<StationApplication['licence']>;
};

export function applicationWith(overrides: ApplicationChanges = {}): StationApplication {
  const base: StationApplication = {
    stationId: STATION_ID,
    status: 'PENDING_VERIFICATION',
    account: { fullName: 'Chanda Mwila', email: 'chanda@example.test', mobileNumber: '+260 97 ••• ••67' },
    verification: { isPhoneVerified: false, isEmailVerified: false, phoneCodeSentAt: new Date().toISOString(), phoneCodeResendAvailableAt: new Date(Date.now() + 45_000).toISOString() },
    details: { name: null, frequencyLabel: null, province: null, city: null, timeZone: 'Africa/Lusaka', coverageNote: null, streamAddress: null, logoAddress: null },
    licence: { licenceNumber: null, document: null, confirmedAt: null },
    submittedAt: null,
    reviewedAt: null,
    rejectionReason: null,
    nextStep: 'verify',
  };
  return {
    ...base,
    ...overrides,
    verification: { ...base.verification, ...overrides.verification },
    details: { ...base.details, ...overrides.details },
    licence: { ...base.licence, ...overrides.licence },
  };
}
