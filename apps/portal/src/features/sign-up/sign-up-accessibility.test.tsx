import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../app/portal-api';
import { findAccessibilityProblems } from '../../test/accessibility';
import { APPLICANT_STATION_ID, applicationWith } from '../../test/application-fixtures';
import { errorResponse, installFakeApi, jsonResponse, signedInUserWith } from '../../test/fake-api';
import { renderPortalAt } from '../../test/render-portal';
import { setScreenWidth } from '../../test/screen-size';

/** P5A design §6 (the jsdom axe pass per page): every sign-up screen, at a phone's width and a desktop's. */
const applicant = signedInUserWith([{ id: APPLICANT_STATION_ID, name: null, frequencyLabel: null, status: 'PENDING_VERIFICATION' }]);
const expectNoProblems = async () => expect(await findAccessibilityProblems()).toEqual([]);

beforeEach(() => {
  window.turnstile = {
    render: (element, options) => {
      element.textContent = 'Human check passed';
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

describe.each([375, 1280])('accessibility of sign-up at %i px', (width) => {
  beforeEach(() => setScreenWidth(width));

  it('step 1', async () => {
    installFakeApi({ 'GET /auth/me': () => errorResponse(401, 'UNAUTHENTICATED', 'Please sign in.'), 'POST /auth/refresh': () => errorResponse(401, 'UNAUTHENTICATED', 'Please sign in.') });
    renderPortalAt('/signup');
    await screen.findByRole('heading', { name: 'Register your station' });
    await expectNoProblems();
  });

  it.each([
    ['verify', 'Check your phone', applicationWith()],
    ['details', 'About your station', applicationWith({ nextStep: 'details', verification: { isPhoneVerified: true } })],
    ['licence', 'Your broadcasting licence', applicationWith({ nextStep: 'licence', verification: { isPhoneVerified: true } })],
    ['', 'Your application needs changes', applicationWith({ status: 'REJECTED', nextStep: 'submitted', rejectionReason: 'The licence document is for another station.', details: { name: 'Sunrise FM', frequencyLabel: '98.1 FM' } })],
    ['', 'Your station is approved', applicationWith({ status: 'ACTIVE', nextStep: 'submitted', submittedAt: '2026-10-14T07:30:00.000Z', reviewedAt: '2026-10-15T04:33:00.000Z', details: { name: 'Sunrise FM', frequencyLabel: '98.1 FM' } })],
  ])('the "%s" page', async (path, heading, application) => {
    installFakeApi({
      'GET /auth/me': () => jsonResponse(200, applicant),
      [`GET /stations/${APPLICANT_STATION_ID}/application`]: () => jsonResponse(200, application),
    });
    renderPortalAt(`/stations/${APPLICANT_STATION_ID}/application${path ? `/${path}` : ''}`);
    await screen.findByRole('heading', { name: heading });
    await expectNoProblems();
  });
});
