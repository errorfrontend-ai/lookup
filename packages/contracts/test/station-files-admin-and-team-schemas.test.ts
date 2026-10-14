import { describe, expect, it } from 'vitest';
import { readReferenceCodeQuery, RejectApplicationInput, ReviewAudioOverlapInput, SuspendStationInput } from '../src/admin/admin-schemas.js';
import { maskPhoneNumberForDisplay } from '../src/phone-numbers/zambian-phone-numbers.js';
import {
  contentTypeForStationFile,
  MAXIMUM_LICENCE_DOCUMENT_SIZE_BYTES,
  StartLicenceDocumentUploadInput,
  StartStationLogoUploadInput,
} from '../src/registration/station-upload-schemas.js';
import { AcceptInvitationWithNewAccountInput, InviteStationMemberInput } from '../src/team/team-schemas.js';

describe('station files (P5A-LICENCE-02, P5A-STATION-DETAILS-07)', () => {
  it('signs a licence document of exactly 5 MB and refuses one byte more', () => {
    expect(MAXIMUM_LICENCE_DOCUMENT_SIZE_BYTES).toBe(5_242_880);
    const document = { fileName: 'licence.pdf', contentType: 'application/pdf', byteCount: 5_242_880 };
    expect(StartLicenceDocumentUploadInput.safeParse(document).success).toBe(true);
    expect(StartLicenceDocumentUploadInput.safeParse({ ...document, byteCount: 5_242_881 }).success).toBe(false);
  });

  it('signs licence documents as PDF or JPG only', () => {
    expect(StartLicenceDocumentUploadInput.safeParse({ fileName: 'licence.jpg', contentType: 'image/jpeg', byteCount: 1000 }).success).toBe(true);
    expect(
      StartLicenceDocumentUploadInput.safeParse({
        fileName: 'licence.docx',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        byteCount: 1000,
      }).success,
    ).toBe(false);
  });

  it('signs logos as PNG or JPG only', () => {
    expect(StartStationLogoUploadInput.safeParse({ fileName: 'logo.png', contentType: 'image/png', byteCount: 1000 }).success).toBe(true);
    expect(StartStationLogoUploadInput.safeParse({ fileName: 'logo.gif', contentType: 'image/gif', byteCount: 1000 }).success).toBe(false);
    expect(StartStationLogoUploadInput.safeParse({ fileName: 'logo.svg', contentType: 'image/svg+xml', byteCount: 1000 }).success).toBe(false);
  });

  it.each([
    [{ type: 'image/png', name: 'logo.png' }, 'logo', 'image/png'],
    [{ type: 'image/jpg', name: 'logo.jpg' }, 'logo', 'image/jpeg'],
    [{ type: '', name: 'LOGO.JPEG' }, 'logo', 'image/jpeg'],
    [{ type: 'image/gif', name: 'logo.gif' }, 'logo', null],
    [{ type: 'image/svg+xml', name: 'logo.svg' }, 'logo', null],
    [{ type: 'application/pdf', name: 'logo.pdf' }, 'logo', null],
    [{ type: 'application/pdf', name: 'licence.pdf' }, 'licence-document', 'application/pdf'],
    [{ type: 'application/octet-stream', name: 'licence.pdf' }, 'licence-document', 'application/pdf'],
    [{ type: 'image/png', name: 'licence.png' }, 'licence-document', null],
    [{ type: 'image/heic', name: 'licence.heic' }, 'licence-document', null],
  ] as const)('signs %o for a %s as %s', (file, purpose, expected) => {
    expect(contentTypeForStationFile(file, purpose)).toBe(expected);
  });
});

describe('masked phone numbers (P5A-SIGNUP-SCREENS-14, P5A-ADMIN-QUEUE-09)', () => {
  it('shows the country code, the first two and the last two digits only', () => {
    expect(maskPhoneNumberForDisplay('+260971234512')).toBe('+260 97 ••• ••12');
  });

  it('never shows the hidden digits', () => {
    expect(maskPhoneNumberForDisplay('+260971234512')).not.toMatch(/12345|345/);
  });

  it('masks another country the same way', () => {
    expect(maskPhoneNumberForDisplay('+27821234567')).toBe('+27 ••• ••67');
  });
});

describe('admin decisions (P5A-ADMIN-QUEUE-14)', () => {
  it('needs a reason of at least 10 characters to reject or suspend', () => {
    expect(RejectApplicationInput.safeParse({ reason: 'Too blurry' }).success).toBe(true);
    expect(RejectApplicationInput.safeParse({ reason: '   blurry  ' }).success).toBe(false);
    expect(RejectApplicationInput.safeParse({}).success).toBe(false);
    expect(SuspendStationInput.safeParse({ reason: 'Scam buttons reported' }).success).toBe(true);
  });

  it('takes an overlap review with or without a note', () => {
    expect(ReviewAudioOverlapInput.safeParse({ note: null }).success).toBe(true);
    expect(ReviewAudioOverlapInput.safeParse({ note: 'Same jingle, different ads' }).success).toBe(true);
  });
});

describe('reference codes (P5A-SYSTEM-HEALTH-05)', () => {
  it.each([
    ['E0AE-F485', { kind: 'prefix', prefix: 'e0aef485' }],
    ['e0aef485', { kind: 'prefix', prefix: 'e0aef485' }],
    [' e0ae-f485 ', { kind: 'prefix', prefix: 'e0aef485' }],
    ['E0AEF485-4BD1-4CA5-92C3-12DDD420E33D', { kind: 'request-id', requestId: 'e0aef485-4bd1-4ca5-92c3-12ddd420e33d' }],
  ])('reads "%s"', (typed, expected) => {
    expect(readReferenceCodeQuery(typed)).toEqual(expected);
  });

  it.each(['', 'E0AE', 'E0AE-F48Z', "e0aef485' OR 1=1", '%'])('refuses "%s"', (typed) => {
    expect(readReferenceCodeQuery(typed)).toBeNull();
  });
});

describe('team invitations (P5A-TEAM-01)', () => {
  it.each(['OWNER', 'MANAGER', 'ANALYST'])('invites with the role %s', (role) => {
    expect(InviteStationMemberInput.safeParse({ email: 'mutale@station.co.zm', role }).success).toBe(true);
  });

  it('refuses any other role', () => {
    expect(InviteStationMemberInput.safeParse({ email: 'mutale@station.co.zm', role: 'SUPER_ADMIN' }).success).toBe(false);
  });

  it('lets an invited person join without a mobile number', () => {
    const accepted = AcceptInvitationWithNewAccountInput.safeParse({ token: 'A'.repeat(43), fullName: 'Mutale Banda', mobileNumber: null, password: 'x' });
    expect(accepted.success).toBe(true);
  });
});
