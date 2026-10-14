import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { TwoFactorCodeInput } from '../src/authentication/authentication-schemas.js';
import {
  ChangeApplicantAccountInput,
  CheckPhoneVerificationCodeInput,
  ConfirmEmailVerificationInput,
  RegisterStationApplicantInput,
  RequestStationDetailChangeInput,
  SaveStationApplicationDetailsInput,
  SaveStationLicenceInput,
  SubmitStationApplicationInput,
} from '../src/registration/registration-schemas.js';
import { ZAMBIAN_PROVINCES } from '../src/stations/station-schemas.js';
import { reasonCodeForIssue, VALIDATION_REASON_CODES } from '../src/validation-reason-codes.js';

const DUMMY_HUMAN_CHECK_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

function applicant(overrides: Record<string, unknown> = {}) {
  return {
    fullName: 'Chanda Mwila',
    email: 'chanda@yourstation.co.zm',
    mobileNumber: '97 123 4567',
    password: 'a long enough pass phrase',
    humanCheckToken: DUMMY_HUMAN_CHECK_TOKEN,
    ...overrides,
  };
}

function stationDetails(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Station B',
    frequencyLabel: '104.3 FM',
    province: 'Copperbelt',
    city: 'Kitwe',
    timeZone: 'Africa/Lusaka',
    coverageNote: null,
    streamAddress: null,
    ...overrides,
  };
}

/** The field paths and reason codes of a refusal, as the API would relay them. */
function refusals(result: z.ZodSafeParseResult<unknown>): Array<{ path: string; code: string }> {
  return result.success ? [] : result.error.issues.map((issue) => ({ path: issue.path.join('.'), code: reasonCodeForIssue(issue) }));
}

describe('step 1: the applicant (P5A-SIGNUP-04, -06)', () => {
  it('takes the four answers and the human check, and stores the mobile number in E.164 form', () => {
    const result = RegisterStationApplicantInput.safeParse(applicant());
    expect(result.success && result.data.mobileNumber).toBe('+260971234567');
  });

  it.each(['fullName', 'email', 'mobileNumber', 'password', 'humanCheckToken'])('refuses the step without %s', (field) => {
    const answers: Record<string, unknown> = applicant();
    delete answers[field];
    expect(refusals(RegisterStationApplicantInput.safeParse(answers)).map((refusal) => refusal.path)).toContain(field);
  });

  it.each(['097123456x', '97 123', 'not a number', '+27 82 123 4567'])('refuses the mobile number "%s" as not a Zambian mobile number', (typed) => {
    expect(refusals(RegisterStationApplicantInput.safeParse(applicant({ mobileNumber: typed })))).toEqual([
      { path: 'mobileNumber', code: 'not_a_zambian_mobile_number' },
    ]);
  });

  it('refuses an email address that is not one', () => {
    expect(refusals(RegisterStationApplicantInput.safeParse(applicant({ email: 'chanda at station' }))).map((refusal) => refusal.path)).toEqual(['email']);
  });

  it('refuses unknown fields, so nothing extra reaches the database', () => {
    expect(RegisterStationApplicantInput.safeParse(applicant({ platformRole: 'SUPER_ADMIN' })).success).toBe(false);
  });

  it('takes the same answers without a password or human check when step 1 is changed later', () => {
    const result = ChangeApplicantAccountInput.safeParse({ fullName: 'Chanda Mwila', email: 'chanda@yourstation.co.zm', mobileNumber: '0977123456' });
    expect(result.success && result.data.mobileNumber).toBe('+260977123456');
  });
});

describe('codes and links (P5A-VERIFICATION-02)', () => {
  it.each(['000123', '999999', '012345'])('takes the 6-digit code "%s" with its leading zeros', (code) => {
    expect(CheckPhoneVerificationCodeInput.parse({ code }).code).toBe(code);
    expect(TwoFactorCodeInput.parse({ code }).code).toBe(code);
  });

  it.each(['12345', '1234567', '12 456', 'abcdef'])('refuses "%s" as a code', (code) => {
    expect(CheckPhoneVerificationCodeInput.safeParse({ code }).success).toBe(false);
  });

  it('takes a 43-character base64url link token and nothing else', () => {
    expect(ConfirmEmailVerificationInput.safeParse({ token: 'A'.repeat(43) }).success).toBe(true);
    expect(ConfirmEmailVerificationInput.safeParse({ token: 'A'.repeat(42) }).success).toBe(false);
    expect(ConfirmEmailVerificationInput.safeParse({ token: `${'A'.repeat(42)}=` }).success).toBe(false);
  });
});

describe('step 3: the station (P5A-STATION-DETAILS-01..05, -08, -09)', () => {
  it('takes the station details with the optional ones left empty', () => {
    expect(SaveStationApplicationDetailsInput.safeParse(stationDetails()).success).toBe(true);
  });

  it.each(ZAMBIAN_PROVINCES.map((province) => [province]))('takes the province %s', (province) => {
    expect(SaveStationApplicationDetailsInput.safeParse(stationDetails({ province })).success).toBe(true);
  });

  it('refuses a province that is not one of the ten', () => {
    expect(ZAMBIAN_PROVINCES).toHaveLength(10);
    expect(refusals(SaveStationApplicationDetailsInput.safeParse(stationDetails({ province: 'Gauteng' }))).map((refusal) => refusal.path)).toEqual(['province']);
  });

  it.each(['name', 'frequencyLabel', 'city'])('refuses the step without %s', (field) => {
    expect(refusals(SaveStationApplicationDetailsInput.safeParse(stationDetails({ [field]: '  ' }))).map((refusal) => refusal.path)).toEqual([field]);
  });

  it('takes a coverage note and an https stream link', () => {
    const result = SaveStationApplicationDetailsInput.safeParse(
      stationDetails({ coverageNote: 'Kitwe and Ndola', streamAddress: 'https://stream.example.zm/live' }),
    );
    expect(result.success).toBe(true);
  });

  it.each(['http://stream.example.zm/live', 'stream.example.zm', 'javascript:alert(1)'])('refuses the stream link "%s" as not https', (streamAddress) => {
    expect(refusals(SaveStationApplicationDetailsInput.safeParse(stationDetails({ streamAddress })))).toEqual([{ path: 'streamAddress', code: 'not_https' }]);
  });

  it('refuses a time-zone name with characters no zone has', () => {
    expect(SaveStationApplicationDetailsInput.safeParse(stationDetails({ timeZone: "Africa/Lusaka'; --" })).success).toBe(false);
  });
});

describe('step 4: the licence (P5A-LICENCE-01, -07)', () => {
  it('takes a licence number', () => {
    expect(SaveStationLicenceInput.parse({ licenceNumber: ' IBA/R/2024/017 ' }).licenceNumber).toBe('IBA/R/2024/017');
  });

  it('refuses to submit without the confirmation', () => {
    expect(SubmitStationApplicationInput.safeParse({ isLicenceConfirmed: true }).success).toBe(true);
    expect(SubmitStationApplicationInput.safeParse({ isLicenceConfirmed: false }).success).toBe(false);
    expect(SubmitStationApplicationInput.safeParse({}).success).toBe(false);
  });

  it('takes a change request with or without a new licence document', () => {
    const change = { name: 'Station B', frequencyLabel: '104.5 FM', licenceNumber: 'IBA/R/2024/017' };
    expect(RequestStationDetailChangeInput.safeParse({ ...change, licenceDocumentUploadId: null }).success).toBe(true);
    expect(RequestStationDetailChangeInput.safeParse({ ...change, licenceDocumentUploadId: '0192a6c4-0000-4000-8000-000000000004' }).success).toBe(true);
    expect(RequestStationDetailChangeInput.safeParse({ ...change, licenceDocumentUploadId: 'licence.pdf' }).success).toBe(false);
  });
});

describe('reason codes', () => {
  it('lists every sign-up rule and file refusal among the reasons the API may relay', () => {
    for (const reason of ['not_a_zambian_mobile_number', 'not_https', 'phone_not_verified', 'email_not_verified', 'licence_document_missing', 'wrong_file_type', 'file_too_large', 'image_too_small']) {
      expect(VALIDATION_REASON_CODES.has(reason)).toBe(true);
    }
  });
});
