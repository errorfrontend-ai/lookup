import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../app/portal-api';
import { errorResponse, installFakeApi, jsonResponse, signedInUserWith } from '../../test/fake-api';
import { applicationWith, type ApplicationChanges, APPLICANT_STATION_ID as STATION_ID } from '../../test/application-fixtures';
import { renderPortalAt } from '../../test/render-portal';
import { applicationStages } from './application-status-page';
import { tidyFrequencyLabel } from '../stations/parse-frequency-label';
import { timeZoneChoices } from './details-step';
import { confirmationPollingInterval } from './use-station-application';
import { minutesAndSeconds, secondsUntil } from './verify-step';
import { linkTokenFrom } from './verify-email-page';

vi.mock('../new-ad/send-file-to-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../new-ad/send-file-to-storage')>()),
  sendFileToStorage: async ({ onProgress }: { onProgress: (fraction: number) => void }) => {
    onProgress(0.4);
    onProgress(1);
    return { status: 200 };
  },
}));

const person = userEvent.setup({ delay: null });
const SIGNED_OUT = {
  'GET /auth/me': () => errorResponse(401, 'UNAUTHENTICATED', 'Please sign in.'),
  'POST /auth/refresh': () => errorResponse(401, 'UNAUTHENTICATED', 'Please sign in.'),
};

const applicant = () => signedInUserWith([{ id: STATION_ID, name: null, frequencyLabel: null, status: 'PENDING_VERIFICATION' }]);

beforeEach(() => {
  window.turnstile = {
    render: (_element, options) => {
      options.callback('XXXX.DUMMY.TOKEN.XXXX');
      return 'widget-1';
    },
    remove: () => undefined,
  };
});
afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
  delete window.turnstile;
});

describe('sign-up step 1', () => {
  it('P5A-SIGNUP-04, -06, -08: asks for the four details with their browser hints, behind the human check, then signs in and goes to Verify', async () => {
    const api = installFakeApi({
      ...SIGNED_OUT,
      'POST /registration/applicants': () => jsonResponse(201, { ...applicant(), stationId: STATION_ID }),
      [`GET /stations/${STATION_ID}/application`]: () => jsonResponse(200, applicationWith()),
    });
    const { router } = renderPortalAt('/signup');
    expect(await screen.findByRole('heading', { name: 'Register your station' })).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 4 · Your account')).toBeInTheDocument();
    const name = screen.getByLabelText('Your full name');
    const email = screen.getByLabelText('Work email');
    const mobile = screen.getByLabelText('Mobile number');
    const password = screen.getByLabelText('Password');
    expect(name).toHaveAttribute('autocomplete', 'name');
    expect(email).toHaveAttribute('autocomplete', 'email');
    expect(mobile).toHaveAttribute('type', 'tel');
    expect(mobile).toHaveAttribute('autocomplete', 'tel-national');
    expect(mobile).toHaveAccessibleDescription("We'll text a 6-digit code to this number.");
    expect(password).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/sign-in');

    const continueButton = screen.getByRole('button', { name: 'Continue' });
    expect(continueButton).toBeDisabled();
    await person.type(name, 'Chanda Mwila');
    await person.type(email, 'chanda@example.test');
    await person.type(mobile, '97 123 4567');
    await person.type(password, 'short');
    expect(continueButton).toBeDisabled();
    await person.type(password, ' but now long enough');
    await person.click(continueButton);

    await waitFor(() => expect(router.state.location.pathname).toBe(`/stations/${STATION_ID}/application/verify`));
    expect(api.calls.find((call) => call.path === '/registration/applicants')?.body).toEqual({
      fullName: 'Chanda Mwila',
      email: 'chanda@example.test',
      mobileNumber: '97 123 4567',
      password: 'short but now long enough',
      humanCheckToken: 'XXXX.DUMMY.TOKEN.XXXX',
    });
    expect(await screen.findByRole('heading', { name: 'Check your phone' })).toBeInTheDocument();
  });

  it('P5A-SIGNUP-07: a taken email offers "Sign in instead"; a refused password says why in plain words', async () => {
    let answer = errorResponse(409, 'EMAIL_ALREADY_REGISTERED', 'This email already has an account. Sign in instead.');
    installFakeApi({ ...SIGNED_OUT, 'POST /registration/applicants': () => answer });
    renderPortalAt('/signup');
    await person.type(await screen.findByLabelText('Your full name'), 'Chanda Mwila');
    await person.type(screen.getByLabelText('Work email'), 'chanda@example.test');
    await person.type(screen.getByLabelText('Mobile number'), '97 123 4567');
    await person.type(screen.getByLabelText('Password'), 'chanda mwila radio station');
    await person.click(screen.getByRole('button', { name: 'Continue' }));
    const taken = await screen.findByText('This email already has an account.');
    expect(within(taken.parentElement as HTMLElement).getByRole('link', { name: 'Sign in instead' })).toHaveAttribute('href', '/sign-in');

    answer = errorResponse(400, 'VALIDATION_FAILED', 'Some details are missing or not valid.', 'b2c3d4e5', [{ path: 'password', code: 'contains_personal_details' }]);
    await person.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText("Don't use your name, email or station name in the password.")).toBeInTheDocument();
  });

  it('says so when the human check cannot load, and offers to try again', async () => {
    delete window.turnstile;
    installFakeApi(SIGNED_OUT);
    const appended = vi.spyOn(document.head, 'append').mockImplementation((...nodes) => {
      for (const node of nodes) if (node instanceof HTMLScriptElement) queueMicrotask(() => node.onerror?.(new Event('error')));
    });
    renderPortalAt('/signup');
    expect(await screen.findByText("The human check couldn't load. Check your connection, then try again.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    appended.mockRestore();
  });
});

describe('sign-up step 2', () => {
  it('P5A-VERIFICATION-01, -06, -09: the code field fills from the SMS, a wrong code says so, the right one confirms the phone; the email pill turns Confirmed by itself', async () => {
    let saved = applicationWith();
    const api = installFakeApi({
      'GET /auth/me': () => jsonResponse(200, applicant()),
      [`GET /stations/${STATION_ID}/application`]: () => jsonResponse(200, saved),
      [`POST /stations/${STATION_ID}/application/phone-verification`]: (body) => {
        if ((body as { code: string }).code !== '042817') return errorResponse(400, 'VERIFICATION_CODE_INCORRECT', "That code isn't right. Check the SMS and try again.");
        saved = applicationWith({ verification: { isPhoneVerified: true } });
        return jsonResponse(204, null);
      },
    });
    renderPortalAt(`/stations/${STATION_ID}/application/verify`);
    expect(await screen.findByText('We sent a 6-digit code by SMS to +260 97 ••• ••67.')).toBeInTheDocument();
    const code = screen.getByLabelText('6-digit code');
    expect(code).toHaveAttribute('inputmode', 'numeric');
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    expect(code).toHaveAttribute('maxlength', '6');
    expect(screen.getByText(/^Resend in 0:4[0-9]$/)).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    expect(screen.getByText('Waiting')).toBeInTheDocument();

    await person.type(code, '111111');
    await person.click(screen.getByRole('button', { name: 'Confirm the code' }));
    expect(await screen.findByText("That code isn't right. Check the SMS and try again.")).toBeInTheDocument();
    await person.clear(code);
    await person.type(code, '04-28 17');
    expect(code).toHaveValue('042817');
    await person.click(screen.getByRole('button', { name: 'Confirm the code' }));
    expect(await screen.findByText('Phone confirmed.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();

    saved = applicationWith({ verification: { isPhoneVerified: true, isEmailVerified: true } });
    await queryClient.refetchQueries();
    expect(await screen.findByText('Confirmed')).toBeInTheDocument();
    expect(api.calls.filter((call) => call.path === '/stations/0190f1a2-0000-7000-8000-000000000100/application/phone-verification')).toHaveLength(2);
  });

  it('offers "Send a new code" once the minute is up, and sends the email link again on request', async () => {
    const api = installFakeApi({
      'GET /auth/me': () => jsonResponse(200, applicant()),
      [`GET /stations/${STATION_ID}/application`]: () => jsonResponse(200, applicationWith({ verification: { phoneCodeResendAvailableAt: new Date(Date.now() - 1000).toISOString() } })),
      [`POST /stations/${STATION_ID}/application/phone-verification-codes`]: () => jsonResponse(200, { sentAt: new Date().toISOString(), resendAvailableAt: new Date(Date.now() + 60_000).toISOString() }),
      [`POST /stations/${STATION_ID}/application/email-verification-links`]: () => jsonResponse(204, null),
    });
    renderPortalAt(`/stations/${STATION_ID}/application/verify`);
    await person.click(await screen.findByRole('button', { name: 'Send a new code' }));
    await person.click(screen.getByRole('button', { name: 'Send the link again' }));
    expect(await screen.findByText('Sent. It can take a minute to arrive.')).toBeInTheDocument();
    expect(api.calls.map((call) => `${call.method} ${call.path}`)).toEqual(expect.arrayContaining([
      `POST /stations/${STATION_ID}/application/phone-verification-codes`,
      `POST /stations/${STATION_ID}/application/email-verification-links`,
    ]));
  });
});

describe('sign-up steps 3 and 4', () => {
  it('step 3 saves the details with the frequency tidied, uploads a logo with its progress, and goes on to the licence', async () => {
    const api = installFakeApi({
      'GET /auth/me': () => jsonResponse(200, applicant()),
      [`GET /stations/${STATION_ID}/application`]: () => jsonResponse(200, applicationWith({ verification: { isPhoneVerified: true }, nextStep: 'details' })),
      [`POST /stations/${STATION_ID}/application/logo-uploads`]: () => jsonResponse(201, { uploadId: '0190f1a2-0000-7000-8000-00000000aaaa', uploadUrl: 'https://storage.example.test/upload', expiresAt: new Date().toISOString() }),
      [`POST /stations/${STATION_ID}/application/logo-uploads/0190f1a2-0000-7000-8000-00000000aaaa/complete`]: () =>
        jsonResponse(201, applicationWith({ details: { logoAddress: 'https://storage.example.test/logo.webp' } })),
      [`PUT /stations/${STATION_ID}/application/details`]: () => jsonResponse(200, applicationWith({ nextStep: 'licence' })),
    });
    const { router } = renderPortalAt(`/stations/${STATION_ID}/application/details`);
    await person.type(await screen.findByLabelText('Station name'), 'Sunrise FM');
    await person.type(screen.getByLabelText('Frequency'), '98.1fm');
    await person.selectOptions(screen.getByLabelText('Province'), 'Copperbelt');
    await person.type(screen.getByLabelText('City or town'), 'Ndola');
    await person.upload(screen.getByLabelText('Add logo · PNG or JPG'), new File(['png'], 'logo.png', { type: 'image/png' }));
    expect(await screen.findByRole('img', { name: "Your station's logo" })).toHaveAttribute('src', 'https://storage.example.test/logo.webp');
    await person.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/stations/${STATION_ID}/application/licence`));
    expect(api.calls.find((call) => call.method === 'PUT')?.body).toMatchObject({ name: 'Sunrise FM', frequencyLabel: '98.1 FM', province: 'Copperbelt', city: 'Ndola', timeZone: 'Africa/Lusaka' });
    expect(api.calls.find((call) => call.path.endsWith('/logo-uploads'))?.body).toEqual({ fileName: 'logo.png', contentType: 'image/png', byteCount: 3 });
  });

  it('step 3 refuses a GIF logo before sending anything', async () => {
    const api = installFakeApi({
      'GET /auth/me': () => jsonResponse(200, applicant()),
      [`GET /stations/${STATION_ID}/application`]: () => jsonResponse(200, applicationWith({ nextStep: 'details' })),
    });
    renderPortalAt(`/stations/${STATION_ID}/application/details`);
    // A browser's "All files" choice gets past the field's accept list; the page checks the type itself.
    const ignoringAccept = userEvent.setup({ delay: null, applyAccept: false });
    await ignoringAccept.upload(await screen.findByLabelText('Add logo · PNG or JPG'), new File(['gif'], 'logo.gif', { type: 'image/gif' }));
    expect(await screen.findByText("Upload failed. This file type isn't accepted here.")).toBeInTheDocument();
    expect(api.calls.some((call) => call.path.includes('logo-uploads'))).toBe(false);
  });

  it('P5A-LICENCE-07: step 4 needs the number, the document and the confirmation; a missing part links to its step', async () => {
    const withDocument = applicationWith({
      nextStep: 'licence',
      verification: { isPhoneVerified: true },
      licence: { licenceNumber: 'IBA/2026/0042', document: { fileName: 'licence.pdf', contentType: 'application/pdf', byteCount: 1234, uploadedAt: new Date().toISOString() } },
    });
    installFakeApi({
      'GET /auth/me': () => jsonResponse(200, applicant()),
      [`GET /stations/${STATION_ID}/application`]: () => jsonResponse(200, withDocument),
      [`POST /stations/${STATION_ID}/application/submission`]: () =>
        errorResponse(409, 'APPLICATION_INCOMPLETE', "Your application isn't finished yet.", 'c3d4e5f6', [{ path: 'email', code: 'email_not_verified' }]),
    });
    renderPortalAt(`/stations/${STATION_ID}/application/licence`);
    expect(await screen.findByRole('heading', { name: 'Your broadcasting licence' })).toBeInTheDocument();
    expect(screen.getByText('licence.pdf')).toBeInTheDocument();
    expect(screen.getByText('Uploaded')).toBeInTheDocument();
    expect(screen.getByText(/Confirm your email before you submit/)).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Submit for review' });
    expect(submit).toBeDisabled();
    await person.click(screen.getByRole('checkbox', { name: 'I confirm this station holds a valid broadcasting licence in Zambia.' }));
    await person.click(submit);
    expect(await screen.findByRole('link', { name: 'The link we emailed you' })).toHaveAttribute('href', `/stations/${STATION_ID}/application/verify`);
  });

  it('after a rejection the button says "Submit again"', async () => {
    installFakeApi({
      'GET /auth/me': () => jsonResponse(200, applicant()),
      [`GET /stations/${STATION_ID}/application`]: () => jsonResponse(200, applicationWith({ status: 'REJECTED', nextStep: 'submitted' })),
    });
    renderPortalAt(`/stations/${STATION_ID}/application/licence`);
    expect(await screen.findByRole('button', { name: 'Submit again' })).toBeInTheDocument();
  });
});

describe('application status and the email link', () => {
  const submitted = (overrides: ApplicationChanges = {}) =>
    applicationWith({ status: 'PENDING_REVIEW', nextStep: 'submitted', submittedAt: '2026-10-14T07:30:00.000Z', details: { name: 'Sunrise FM', frequencyLabel: '98.1 FM' }, ...overrides });

  it('journey B: an applicant under review lands on the status page, with the current stage marked', async () => {
    installFakeApi({
      'GET /auth/me': () => jsonResponse(200, signedInUserWith([{ id: STATION_ID, name: 'Sunrise FM', status: 'PENDING_REVIEW' }])),
      [`GET /stations/${STATION_ID}/application`]: () => jsonResponse(200, submitted()),
    });
    const { router } = renderPortalAt('/');
    expect(await screen.findByRole('heading', { name: 'Thanks — your application is in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/stations/${STATION_ID}/application`);
    expect(screen.getByText('Sunrise FM · 98.1 FM')).toBeInTheDocument();
    const current = within(screen.getByRole('region', { name: 'Application progress' })).getByText('Under review').closest('li');
    expect(current).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('link', { name: 'Edit application' })).toHaveAttribute('href', `/stations/${STATION_ID}/application/details`);
  });

  it('journey D: a rejection shows the reviewer\'s words as they wrote them, and "Fix and submit again"', async () => {
    installFakeApi({
      'GET /auth/me': () => jsonResponse(200, signedInUserWith([{ id: STATION_ID, name: 'Sunrise FM', status: 'REJECTED' }])),
      [`GET /stations/${STATION_ID}/application`]: () => jsonResponse(200, submitted({ status: 'REJECTED', rejectionReason: 'The licence document is for another station.' })),
    });
    renderPortalAt(`/stations/${STATION_ID}/application`);
    expect(await screen.findByText('The licence document is for another station.')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Application progress' })).getByText('Rejected').closest('li')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('link', { name: 'Fix and submit again' })).toBeInTheDocument();
  });

  it('a station still signing up is sent from its pages to the step it is on', async () => {
    installFakeApi({
      'GET /auth/me': () => jsonResponse(200, applicant()),
      [`GET /stations/${STATION_ID}/application`]: () => jsonResponse(200, applicationWith()),
    });
    const { router } = renderPortalAt(`/stations/${STATION_ID}/overview`);
    expect(await screen.findByRole('heading', { name: 'Check your phone' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/stations/${STATION_ID}/application/verify`);
  });

  it('P5A-VERIFICATION-09: the email link confirms on any device, signed in or not, and leaves no token in the address', async () => {
    const token = 'A'.repeat(43);
    window.history.replaceState(null, '', `/verify-email#token=${token}`);
    const api = installFakeApi({ ...SIGNED_OUT, 'POST /registration/email-verifications': () => jsonResponse(204, null) });
    renderPortalAt('/verify-email');
    expect(await screen.findByRole('heading', { name: 'Your email is confirmed' })).toBeInTheDocument();
    expect(api.calls.find((call) => call.path === '/registration/email-verifications')?.body).toEqual({ token });
    expect(window.location.hash).toBe('');
  });

  it("the email link's token leaves the address bar, and the browser's own record of the page stays as the router wrote it", async () => {
    window.history.replaceState({ usr: null, key: 'k2', idx: 2 }, '', `/verify-email#token=${'C'.repeat(43)}`);
    installFakeApi({ ...SIGNED_OUT, 'POST /registration/email-verifications': () => jsonResponse(204, null) });
    renderPortalAt('/verify-email');
    expect(await screen.findByRole('heading', { name: 'Your email is confirmed' })).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    expect(window.history.state).toEqual({ usr: null, key: 'k2', idx: 2 });
  });

  it('an expired link says so in the catalogue\'s words', async () => {
    window.history.replaceState(null, '', `/verify-email#token=${'B'.repeat(43)}`);
    installFakeApi({ ...SIGNED_OUT, 'POST /registration/email-verifications': () => errorResponse(400, 'EMAIL_LINK_EXPIRED', 'This link has expired. Ask for a new one on the sign-up page.') });
    renderPortalAt('/verify-email');
    expect(await screen.findByRole('heading', { name: 'This link has expired' })).toBeInTheDocument();
    expect(screen.getByText('This link has expired. Ask for a new one on the sign-up page.')).toBeInTheDocument();
  });
});

describe('the rules behind the pages', () => {
  it('asks every 5 s for 2 minutes, then every 15 s, and stops after 30 minutes', () => {
    expect([confirmationPollingInterval(0), confirmationPollingInterval(119_999), confirmationPollingInterval(120_000), confirmationPollingInterval(1_799_999), confirmationPollingInterval(1_800_000)]).toEqual([
      5_000, 5_000, 15_000, 15_000, false,
    ]);
  });

  it('counts down to the next code, and reads the token from the fragment only when it is one', () => {
    expect(secondsUntil(new Date(10_500).toISOString(), 0)).toBe(11);
    expect(secondsUntil(null, 0)).toBe(0);
    expect(minutesAndSeconds(45)).toBe('0:45');
    expect(minutesAndSeconds(60)).toBe('1:00');
    expect(linkTokenFrom(`#token=${'a'.repeat(43)}`)).toBe('a'.repeat(43));
    expect(linkTokenFrom('#token=short')).toBeNull();
    expect(linkTokenFrom('')).toBeNull();
  });

  it('tidies a frequency, keeps Lusaka among the time zones, and lists the stages', () => {
    expect(tidyFrequencyLabel(' 98.1fm ')).toBe('98.1 FM');
    expect(tidyFrequencyLabel('Radio 1')).toBe('Radio 1');
    expect(timeZoneChoices('Africa/Harare')).toEqual(expect.arrayContaining(['Africa/Lusaka', 'Africa/Harare']));
    expect(applicationStages({ status: 'ACTIVE', submittedAt: null, reviewedAt: null, rejectionReason: null }).map((stage) => stage.state)).toEqual(['done', 'done', 'finished']);
  });
});
