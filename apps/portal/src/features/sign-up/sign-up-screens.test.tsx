import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../app/portal-api';
import { FileUploadField } from '../../components/file-upload-field';
import { errorResponse, installFakeApi, jsonResponse, signedInUserWith } from '../../test/fake-api';
import { applicationWith, type ApplicationChanges, APPLICANT_STATION_ID as STATION_ID } from '../../test/application-fixtures';
import { renderPortalAt } from '../../test/render-portal';
import { forgetAllDrafts } from '../session/unsaved-answers';

/**
 * The sign-up screens as the wireframes and P5A design §4.2 draw them (P5A-SIGNUP-SCREENS-01..28): the words, the
 * fields' attributes, the step indicator, the panels and the upload states. The browser journeys check what needs a
 * real browser (sizes, the human check, Back keeping answers).
 */

// Storage answers as each test sets: a failure first, then success, for "Try again".
const storageAnswers: Array<number | 'network'> = [];
vi.mock('../new-ad/send-file-to-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../new-ad/send-file-to-storage')>()),
  sendFileToStorage: async ({ onProgress }: { onProgress: (fraction: number) => void }) => {
    onProgress(0.4);
    const answer = storageAnswers.shift() ?? 200;
    if (answer === 'network') throw new TypeError('Failed to fetch');
    onProgress(1);
    return { status: answer };
  },
}));

const person = userEvent.setup({ delay: null });
const SIGNED_OUT = {
  'GET /auth/me': () => errorResponse(401, 'UNAUTHENTICATED', 'Please sign in.'),
  'POST /auth/refresh': () => errorResponse(401, 'UNAUTHENTICATED', 'Please sign in.'),
};
const applicant = () => signedInUserWith([{ id: STATION_ID, name: null, frequencyLabel: null, status: 'PENDING_VERIFICATION' }]);
const STEP_PATHS = { verify: 'verify', details: 'details', licence: 'licence' } as const;

/** One of steps 2 to 4, with the application as given. */
function renderStep(step: keyof typeof STEP_PATHS, changes: ApplicationChanges = {}, handlers: Record<string, Parameters<typeof installFakeApi>[0][string]> = {}) {
  const api = installFakeApi({
    'GET /auth/me': () => jsonResponse(200, applicant()),
    [`GET /stations/${STATION_ID}/application`]: () => jsonResponse(200, applicationWith({ nextStep: step, ...changes })),
    ...handlers,
  });
  return { api, ...renderPortalAt(`/stations/${STATION_ID}/application/${STEP_PATHS[step]}`) };
}

/** The four parts of the progress bar, and which of them are filled. */
function filledParts(): boolean[] {
  const bar = screen.getByText(/^Step [1-4] of 4 · /).nextElementSibling as HTMLElement;
  expect(bar).toHaveAttribute('aria-hidden', 'true');
  return [...bar.children].map((part) => part.classList.contains('bg-accent'));
}

beforeEach(() => {
  storageAnswers.length = 0;
  window.turnstile = { render: (_element, options) => (options.callback('XXXX.DUMMY.TOKEN.XXXX'), 'widget-1'), remove: () => undefined };
});
afterEach(async () => {
  // Let requests in flight finish first: a failed session refresh clears the shared cache's signed-in person, and
  // must not do so in the next test. Then unmount: leaving a step keeps its draft, which would reach the next test too.
  await waitFor(() => expect(queryClient.isFetching() + queryClient.isMutating()).toBe(0));
  cleanup();
  queryClient.clear();
  forgetAllDrafts();
  vi.useRealTimers();
  delete window.turnstile;
});

describe('the frame of every step', () => {
  it('P5A-SIGNUP-SCREENS-01..04, -12: step 1 reads "Step 1 of 4 · Your account" over one filled part, has no Back, and ends with a full-width "Continue"', async () => {
    installFakeApi(SIGNED_OUT);
    renderPortalAt('/signup');
    expect(await screen.findByText('Step 1 of 4 · Your account')).toBeInTheDocument();
    expect(filledParts()).toEqual([true, false, false, false]);
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveClass('w-full', 'min-h-13');
  });

  it.each([
    ['verify', 'Step 2 of 4 · Verify', [true, true, false, false], 'Continue'],
    ['details', 'Step 3 of 4 · Station details', [true, true, true, false], 'Continue'],
    ['licence', 'Step 4 of 4 · Licence', [true, true, true, true], 'Submit for review'],
  ] as const)('P5A-SIGNUP-SCREENS-01..04, -12: %s reads "%s" over its filled parts, has a 48 × 48 "Back", and a full-width main button', async (step, words, filled, mainButton) => {
    renderStep(step, { verification: { isPhoneVerified: true } });
    expect(await screen.findByText(words)).toBeInTheDocument();
    expect(filledParts()).toEqual(filled);
    expect(screen.getByRole('button', { name: 'Back' })).toHaveClass('size-12');
    expect(screen.getByRole('button', { name: mainButton })).toHaveClass('w-full', 'min-h-13');
  });

  it('P5A-SIGNUP-SCREENS-04: answers typed on step 3 but not saved yet survive going Back and coming forward again', async () => {
    renderStep('details', { verification: { isPhoneVerified: true } });
    await person.type(await screen.findByLabelText('Station name'), 'Sunrise FM');
    await person.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Check your phone' })).toBeInTheDocument();
    await person.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByLabelText('Station name')).toHaveValue('Sunrise FM');
  });

  it('P5A-SIGNUP-SCREENS-04: a licence number typed on step 4 but not saved yet survives going Back and coming forward again', async () => {
    const saved = { verification: { isPhoneVerified: true }, details: { name: 'Sunrise FM', frequencyLabel: '98.1 FM', province: 'Copperbelt', city: 'Ndola' } };
    renderStep('licence', saved, {
      [`PUT /stations/${STATION_ID}/application/details`]: () => jsonResponse(200, applicationWith({ ...saved, nextStep: 'licence' })),
    });
    await person.type(await screen.findByLabelText('Licence number'), 'IBA/2026/0042');
    await person.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'About your station' })).toBeInTheDocument();
    await person.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Your broadcasting licence' })).toBeInTheDocument();
    expect(screen.getByLabelText('Licence number')).toHaveValue('IBA/2026/0042');
  });
});

describe('step 1, Register your station', () => {
  beforeEach(() => {
    installFakeApi(SIGNED_OUT);
  });

  it('P5A-SIGNUP-SCREENS-05, -06: "Look Up · for stations", a "Sign in" link, the heading and its line', async () => {
    renderPortalAt('/signup');
    expect(await screen.findByRole('heading', { level: 1, name: 'Register your station' })).toBeInTheDocument();
    expect(screen.getByText('About 5 minutes. We save as you go, so you can stop and come back.')).toBeInTheDocument();
    expect(screen.getByText('Look Up')).toBeInTheDocument();
    expect(screen.getByText('for stations')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/sign-in');
  });

  it('P5A-SIGNUP-SCREENS-07, -08, -09: each field found by its label, with the browser hints and examples', async () => {
    renderPortalAt('/signup');
    expect(await screen.findByLabelText('Your full name')).toHaveAttribute('autocomplete', 'name');
    const email = screen.getByLabelText('Work email');
    expect(email).toHaveAttribute('type', 'email');
    expect(email).toHaveAttribute('autocomplete', 'email');
    expect(email).toHaveAttribute('placeholder', 'you@yourstation.co.zm');
    const mobile = screen.getByLabelText('Mobile number');
    expect(mobile).toHaveAttribute('type', 'tel');
    expect(mobile).toHaveAttribute('autocomplete', 'tel-national');
    expect(mobile).toHaveAttribute('placeholder', '97 123 4567');
    expect(mobile).toHaveAccessibleDescription("We'll text a 6-digit code to this number.");
    // The fixed +260 sits beside the field, not in it.
    expect(mobile.previousElementSibling).toHaveTextContent('+260');
    expect(screen.getByLabelText('Password', { selector: 'input' })).toBeInTheDocument();
  });

  it('P5A-SIGNUP-SCREENS-10: the password field names the real minimum, and a 14-character password is refused before anything is sent', async () => {
    renderPortalAt('/signup');
    const password = await screen.findByLabelText('Password');
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('autocomplete', 'new-password');
    expect(password).toHaveAccessibleDescription('At least 15 characters.');
    await person.type(password, 'fourteen chars');
    expect(screen.queryByText('Use at least 15 characters.')).not.toBeInTheDocument();
    await person.tab();
    expect(await screen.findByText('Use at least 15 characters.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await person.type(password, '!');
    expect(screen.queryByText('Use at least 15 characters.')).not.toBeInTheDocument();
  });

  it('P5A-SIGNUP-SCREENS-11: the human check sits on step 1, above "Continue"', async () => {
    const render = vi.fn((_element: HTMLElement) => 'widget-1');
    window.turnstile = { render, remove: () => undefined };
    renderPortalAt('/signup');
    await waitFor(() => expect(render).toHaveBeenCalledTimes(1));
    const widget = render.mock.calls[0]?.[0] as HTMLElement;
    const continueButton = screen.getByRole('button', { name: 'Continue' });
    expect(widget.compareDocumentPosition(continueButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('step 2, Check your phone', () => {
  it('P5A-SIGNUP-SCREENS-14: the number shows only +260, two digits and the last two; the full number is never on the page', async () => {
    renderStep('verify');
    expect(await screen.findByText('We sent a 6-digit code by SMS to +260 97 ••• ••67.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Check your phone' })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\+?260\s?9[5-7]\s?[0-9]{3}\s?[0-9]{4}/);
  });

  it('P5A-SIGNUP-SCREENS-15: "6-digit code" opens a number pad and takes the code from the SMS', async () => {
    renderStep('verify');
    const code = await screen.findByLabelText('6-digit code');
    expect(code).toHaveAttribute('inputmode', 'numeric');
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    expect(code).toHaveAttribute('maxlength', '6');
  });

  it('P5A-SIGNUP-SCREENS-16: "Didn\'t get it?" beside a polite countdown from 1:00 to 0:00, which then becomes "Send a new code"', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date('2026-10-14T09:00:00.000Z') });
    renderStep('verify', { verification: { phoneCodeResendAvailableAt: '2026-10-14T09:01:00.000Z' } });
    expect(await screen.findByText('Resend in 1:00')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByText("Didn't get it?")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send a new code' })).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_000);
    });
    expect(screen.getByText('Resend in 0:01')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.queryByText(/^Resend in/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send a new code' })).toBeInTheDocument();
  });

  it('P5A-SIGNUP-SCREENS-17: the "Confirm your email" panel says where the link went, shows "Waiting", and sends it again', async () => {
    const { api } = renderStep('verify', {}, { [`POST /stations/${STATION_ID}/application/email-verification-links`]: () => jsonResponse(204, null) });
    const panel = await screen.findByRole('region', { name: 'Confirm your email' });
    expect(panel).toHaveTextContent('Waiting');
    expect(panel).toHaveTextContent('We sent a link to chanda@example.test. Open it on any device — this page updates by itself.');
    await person.click(screen.getByRole('button', { name: 'Send the link again' }));
    expect(await screen.findByText('Sent. It can take a minute to arrive.')).toBeInTheDocument();
    expect(api.calls.filter((call) => call.path.endsWith('/email-verification-links'))).toHaveLength(1);
  });
});

describe('step 3, About your station', () => {
  it('P5A-SIGNUP-SCREENS-19, -20: the heading, the frequency example, "Choose province" first, and the logo control', async () => {
    renderStep('details');
    expect(await screen.findByRole('heading', { level: 1, name: 'About your station' })).toBeInTheDocument();
    expect(screen.getByLabelText('Frequency')).toHaveAccessibleDescription('e.g. 98.1 FM');
    const province = screen.getByLabelText('Province') as HTMLSelectElement;
    expect(province.value).toBe('');
    // P5A-STATION-DETAILS-03: the prompt, then exactly the ten provinces.
    expect([...province.options].map((option) => option.textContent)).toEqual([
      'Choose province', 'Central', 'Copperbelt', 'Eastern', 'Luapula', 'Lusaka', 'Muchinga', 'Northern', 'North-Western', 'Southern', 'Western',
    ]);
    expect(screen.getByLabelText('Add logo · PNG or JPG')).toHaveAttribute('type', 'file');
  });

  it('P5A-SIGNUP-SCREENS-21: the optional details are folded away until opened', async () => {
    renderStep('details');
    const summary = await screen.findByText('More details (optional) — time zone, coverage, stream link');
    const details = summary.closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    await person.click(summary);
    expect(details.open).toBe(true);
    expect(screen.getByLabelText('Time zone')).toBeVisible();
  });

  it('P5A-SIGNUP-SCREENS-28: a logo upload shows its progress; after a failed connection "Try again" sends the same file again', async () => {
    storageAnswers.push('network', 200);
    const uploadId = '0190f1a2-0000-7000-8000-00000000aaaa';
    const { api } = renderStep('details', {}, {
      [`POST /stations/${STATION_ID}/application/logo-uploads`]: () => jsonResponse(201, { uploadId, uploadUrl: 'https://storage.example.test/upload', expiresAt: new Date().toISOString() }),
      [`POST /stations/${STATION_ID}/application/logo-uploads/${uploadId}/complete`]: () => jsonResponse(201, applicationWith({ nextStep: 'details', details: { logoAddress: 'https://storage.example.test/logo.webp' } })),
    });
    await person.upload(await screen.findByLabelText('Add logo · PNG or JPG'), new File(['png'], 'logo.png', { type: 'image/png' }));
    expect(await screen.findByText("Upload failed. The upload didn't finish. Check your connection, then try again.")).toBeInTheDocument();
    await person.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('img', { name: "Your station's logo" })).toBeInTheDocument();
    expect(screen.getByText('Uploaded')).toBeInTheDocument();
    expect(api.calls.filter((call) => call.path.endsWith('/logo-uploads'))).toHaveLength(2);
  });

  it('a file that is itself wrong offers no "Try again": another file is needed', async () => {
    renderStep('details');
    const ignoringAccept = userEvent.setup({ delay: null, applyAccept: false });
    await ignoringAccept.upload(await screen.findByLabelText('Add logo · PNG or JPG'), new File(['gif'], 'logo.gif', { type: 'image/gif' }));
    expect(await screen.findByText("Upload failed. This file type isn't accepted here.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});

describe('step 4, Your broadcasting licence', () => {
  it('P5A-SIGNUP-SCREENS-22, -24, -26: the heading and why, the document\'s helper, and what happens next', async () => {
    renderStep('licence');
    expect(await screen.findByRole('heading', { level: 1, name: 'Your broadcasting licence' })).toBeInTheDocument();
    expect(screen.getByText('We check every station before it goes live. It stops fake stations putting scam buttons on real ads.')).toBeInTheDocument();
    expect(screen.getByLabelText('Licence document')).toHaveAccessibleDescription('PDF or a clear photo, up to 5 MB. Only our review team can see it.');
    expect(screen.getByText('What happens next: we review your application within 2 working days and let you know by SMS and email.')).toBeInTheDocument();
  });

  it('P5A-LICENCE-06: the document\'s upload shows its progress; after a failed connection "Try again" sends the same file again', async () => {
    storageAnswers.push('network', 200);
    const uploadId = '0190f1a2-0000-7000-8000-00000000bbbb';
    const document = { fileName: 'licence.pdf', contentType: 'application/pdf' as const, byteCount: 4, uploadedAt: new Date().toISOString() };
    const { api } = renderStep('licence', {}, {
      [`POST /stations/${STATION_ID}/application/licence-document-uploads`]: () => jsonResponse(201, { uploadId, uploadUrl: 'https://storage.example.test/upload', expiresAt: new Date().toISOString() }),
      [`POST /stations/${STATION_ID}/application/licence-document-uploads/${uploadId}/complete`]: () => jsonResponse(201, applicationWith({ nextStep: 'licence', licence: { document } })),
    });
    await person.upload(await screen.findByLabelText('Licence document'), new File(['%PDF'], 'licence.pdf', { type: 'application/pdf' }));
    expect(await screen.findByText("Upload failed. The upload didn't finish. Check your connection, then try again.")).toBeInTheDocument();
    await person.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Uploaded')).toBeInTheDocument();
    expect(screen.getByText('licence.pdf')).toBeInTheDocument();
    expect(api.calls.filter((call) => call.path.endsWith('/licence-document-uploads'))).toHaveLength(2);
  });

  it('P5A-SIGNUP-SCREENS-25: the confirmation starts unticked, and "Submit for review" waits for it', async () => {
    renderStep('licence', {
      verification: { isPhoneVerified: true, isEmailVerified: true },
      licence: { licenceNumber: 'IBA/2026/0042', document: { fileName: 'licence.pdf', contentType: 'application/pdf', byteCount: 1234, uploadedAt: new Date().toISOString() } },
    });
    const confirmation = await screen.findByRole('checkbox', { name: 'I confirm this station holds a valid broadcasting licence in Zambia.' });
    expect(confirmation).not.toBeChecked();
    const submit = screen.getByRole('button', { name: 'Submit for review' });
    expect(submit).toBeDisabled();
    await person.click(confirmation);
    expect(submit).toBeEnabled();
  });
});

describe('the upload control (step 3\'s logo, step 4\'s document)', () => {
  const field = (state: Parameters<typeof FileUploadField>[0]['state'], onTryAgain?: () => void) =>
    render(<FileUploadField label="Licence document" hint="PDF or a clear photo, up to 5 MB." accept="application/pdf" savedFileName={null} state={state} onChoose={() => undefined} onTryAgain={onTryAgain} />);

  it('P5A-SIGNUP-SCREENS-23: uploading shows the name and a progress bar; uploaded shows "Uploaded" in green and "Replace"; failed says why', () => {
    const uploading = field({ stage: 'uploading', fileName: 'licence.pdf', percent: 40 });
    expect(screen.getByText('licence.pdf')).toBeInTheDocument();
    expect(screen.getByText('Uploading 40 %')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Uploading licence.pdf' })).toBeInTheDocument();
    uploading.unmount();

    const uploaded = field({ stage: 'done', fileName: 'licence.pdf' });
    expect(screen.getByText('Uploaded')).toHaveClass('text-success');
    expect(screen.getByRole('button', { name: 'Replace' })).toBeInTheDocument();
    uploaded.unmount();

    const tryAgain = vi.fn();
    field({ stage: 'failed', fileName: 'licence.pdf', reason: 'upload_not_received' }, tryAgain);
    expect(screen.getByRole('alert')).toHaveTextContent("Upload failed. The file didn't arrive. Choose it again.");
    expect(screen.getByRole('button', { name: 'Replace' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('Application status', () => {
  const submitted = (changes: ApplicationChanges = {}) =>
    applicationWith({ status: 'PENDING_REVIEW', nextStep: 'submitted', submittedAt: '2026-10-14T07:30:00.000Z', details: { name: 'Sunrise FM', frequencyLabel: '98.1 FM' }, ...changes });
  const renderStatus = (application = submitted(), handlers: Parameters<typeof installFakeApi>[0] = {}) => {
    const api = installFakeApi({
      'GET /auth/me': () => jsonResponse(200, signedInUserWith([{ id: STATION_ID, name: 'Sunrise FM', status: application.status }])),
      [`GET /stations/${STATION_ID}/application`]: () => jsonResponse(200, application),
      ...handlers,
    });
    return { api, ...renderPortalAt(`/stations/${STATION_ID}/application`) };
  };
  const stage = (name: string) => screen.getByText(name, { selector: 'span' }).closest('li') as HTMLElement;

  it('P5A-APPLICATION-STATUS-05, -06, -10: the heading with the station, the three stages with their lines, and the closing line', async () => {
    renderStatus();
    expect(await screen.findByRole('heading', { level: 1, name: 'Thanks — your application is in' })).toBeInTheDocument();
    expect(screen.getByText('Sunrise FM · 98.1 FM')).toBeInTheDocument();
    const progress = screen.getByRole('region', { name: 'Application progress' });
    expect([...progress.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      `Submitted${new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date('2026-10-14T07:30:00.000Z'))}`,
      'Under reviewUsually within 2 working days',
      "ApprovedWe'll text and email you",
    ]);
    expect(screen.getByText("If anything is missing we'll tell you exactly what to fix — nothing is lost.")).toBeInTheDocument();
  });

  it('P5A-APPLICATION-STATUS-02, -07: under review, Submitted is done with a tick, Under review is current, Approved is still to come', async () => {
    renderStatus();
    await screen.findByRole('region', { name: 'Application progress' });
    expect(stage('Submitted').querySelector('svg')).not.toBeNull();
    expect(stage('Submitted')).not.toHaveAttribute('aria-current');
    expect(stage('Under review')).toHaveAttribute('aria-current', 'step');
    expect(stage('Approved')).not.toHaveAttribute('aria-current');
    expect(stage('Approved').querySelector('svg')).toBeNull();
  });

  it('P5A-APPLICATION-STATUS-02, -08: rejected, "Rejected" takes Approved’s place with the reviewer’s words; approved, Approved is current', async () => {
    const rejected = renderStatus(submitted({ status: 'REJECTED', rejectionReason: 'The licence photo is too blurry.\nPlease upload a clearer copy.' }));
    await screen.findByRole('region', { name: 'Application progress' });
    expect(stage('Rejected')).toHaveAttribute('aria-current', 'step');
    expect(stage('Rejected')).toHaveTextContent('The licence photo is too blurry. Please upload a clearer copy.');
    expect(screen.queryByText('Approved', { selector: 'span' })).not.toBeInTheDocument();
    rejected.unmount();
    queryClient.clear();

    renderStatus(submitted({ status: 'ACTIVE' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Your station is approved' })).toBeInTheDocument();
    expect(stage('Approved')).toHaveAttribute('aria-current', 'step');
    expect(stage('Under review').querySelector('svg')).not.toBeNull();
  });

  it('P5A-APPLICATION-STATUS-04, -09: "Look Up" and "Sign out", which ends the session; "While you wait" offers "Edit application"', async () => {
    const { api, router } = renderStatus(submitted(), { 'POST /auth/sign-out': () => jsonResponse(204, null) });
    expect(await screen.findByText('Look Up')).toBeInTheDocument();
    const waiting = screen.getByRole('region', { name: 'While you wait' });
    expect(waiting).toHaveTextContent('You can still change your details. Uploading ads unlocks once your station is approved.');
    expect(within(waiting).getByRole('link', { name: 'Edit application' })).toHaveAttribute('href', `/stations/${STATION_ID}/application/details`);
    await person.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/sign-in'));
    expect(api.calls.some((call) => call.method === 'POST' && call.path === '/auth/sign-out')).toBe(true);
  });
});
