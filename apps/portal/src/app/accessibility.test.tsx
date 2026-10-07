import type { AdDetail } from '@lookup/contracts';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllUploads } from '../features/new-ad/ad-upload-store';
import { findAccessibilityProblems } from '../test/accessibility';
import { adDetail, adSummary, campaignSummary, historyEvent, overviewFor, scheduleFixture } from '../test/ad-fixtures';
import { errorResponse, installFakeApi, jsonResponse, signedInUserWith } from '../test/fake-api';
import { renderPortalAt } from '../test/render-portal';
import { setScreenWidth } from '../test/screen-size';
import { queryClient } from './portal-api';

const person = userEvent.setup({ delay: null });
const owner = signedInUserWith([{ role: 'OWNER', name: 'Radio Phoenix', frequencyLabel: '89.5 FM' }]);
const stationId = owner.stations[0]?.id as string;
const brandA = { id: '0190f1a2-0000-7000-8000-0000000000a1', name: 'Brand A', adCount: 3, liveNowAdCount: 1 };

const liveAd = adDetail({ title: 'Summer service offer' });
const draftAd = adDetail({
  title: 'Back to school offer',
  status: 'PROCESSING',
  campaign: campaignSummary({ displayStatus: 'DRAFT', startsOn: '2026-10-06', endsOn: '2026-11-02' }),
  schedule: scheduleFixture({ displayStatus: 'DRAFT', startsOn: '2026-10-06', endsOn: '2026-11-02' }),
});
const bareAd = adDetail({ title: 'Festive greetings', status: 'PROCESSING', actionCard: null, schedule: null, campaign: null });
const refused = adSummary({ title: 'Refused file', status: 'FAILED', campaign: null, hasActionCard: false, attentionReasons: ['upload_refused'] });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-06T08:00:00Z'));
  setScreenWidth(1280);
  installFakeApi({
    'GET /auth/me': () => jsonResponse(200, owner),
    [`GET /stations/${stationId}`]: () => jsonResponse(200, { id: stationId, name: 'Radio Phoenix', frequencyLabel: '89.5 FM', province: 'Lusaka', city: 'Lusaka', timeZone: 'Africa/Lusaka', status: 'ACTIVE' }),
    [`GET /stations/${stationId}/overview`]: () => jsonResponse(200, overviewFor([liveAd, refused])),
    [`GET /stations/${stationId}/clients`]: () => jsonResponse(200, [brandA]),
    [`GET /stations/${stationId}/ads`]: () => jsonResponse(200, { ads: [liveAd, draftAd, refused], nextCursor: null }),
    ...Object.fromEntries(
      [liveAd, draftAd, bareAd].flatMap((ad: AdDetail) => [
        [`GET /stations/${stationId}/ads/${ad.id}`, () => jsonResponse(200, ad)],
        [`GET /stations/${stationId}/ads/${ad.id}/history`, () => jsonResponse(200, { events: [historyEvent({ kind: 'ad_created', fileName: 'offer.mp3' })], nextCursor: null })],
      ]),
    ),
  });
});

afterEach(() => {
  vi.useRealTimers();
  clearAllUploads();
  queryClient.clear();
  vi.unstubAllGlobals();
});

const expectNoProblems = async () => expect(await findAccessibilityProblems()).toEqual([]);

describe('the accessibility check itself', () => {
  it('does find problems when there are some, so a clean result means something', async () => {
    const planted = document.createElement('div');
    planted.innerHTML = '<input type="text"><img src="x.png"><button type="button"></button>';
    document.body.append(planted);
    try {
      const problems = await findAccessibilityProblems(planted);
      expect(problems.map((problem) => problem.split(':')[0]).sort()).toEqual(['button-name', 'image-alt', 'label']);
    } finally {
      planted.remove();
    }
  });
});

describe('accessibility: what axe finds on each screen', () => {
  it('sign in', async () => {
    installFakeApi({ 'GET /auth/me': () => errorResponse(401, 'NOT_SIGNED_IN', 'Please sign in.'), 'POST /auth/refresh': () => errorResponse(401, 'NOT_SIGNED_IN', 'Please sign in.') });
    renderPortalAt('/sign-in');
    await screen.findByRole('button', { name: 'Sign in' });
    await expectNoProblems();
  });

  it('the overview', async () => {
    renderPortalAt(`/stations/${stationId}/overview`);
    await screen.findByRole('region', { name: 'Needs attention' });
    await expectNoProblems();
  });

  it('the ads list, as a table and as cards', async () => {
    const { unmount } = renderPortalAt(`/stations/${stationId}/ads`);
    await screen.findByRole('table');
    await expectNoProblems();
    unmount();

    setScreenWidth(375);
    renderPortalAt(`/stations/${stationId}/ads`);
    await screen.findByText('Refused file');
    await expectNoProblems();
  });

  it.each(['', '?tab=buttons', '?tab=schedule', '?tab=history'])("an ad's own page %s", async (tab) => {
    renderPortalAt(`/stations/${stationId}/ads/${liveAd.id}${tab}`);
    await screen.findByRole('heading', { level: 1, name: 'Summer service offer' });
    await screen.findAllByText(/Brand A/);
    await expectNoProblems();
  });

  it('clients and the station profile', async () => {
    const { unmount } = renderPortalAt(`/stations/${stationId}/clients`);
    await screen.findByText('Brand A');
    await expectNoProblems();
    unmount();

    renderPortalAt(`/stations/${stationId}/profile`);
    await screen.findByRole('heading', { level: 1, name: 'Station profile' });
    await expectNoProblems();
  });

  it('the new-ad wizard: who it is for, and the audio with a file chosen', async () => {
    renderPortalAt(`/stations/${stationId}/ads/new`);
    await person.click(await screen.findByRole('radio', { name: /Brand A/ }));
    await expectNoProblems();

    await person.click(screen.getByRole('button', { name: 'Next: Audio' }));
    await person.upload(screen.getByLabelText('Audio file'), new File([new Uint8Array(2_048)], 'summer_offer.mp3', { type: 'audio/mpeg' }));
    await screen.findByLabelText('Ad title');
    await expectNoProblems();
  });

  it('the buttons step, with every kind of button and problems showing', async () => {
    renderPortalAt(`/stations/${stationId}/ads/${bareAd.id}/setup?step=buttons`);
    await screen.findByRole('heading', { level: 1, name: 'Add the buttons' });
    for (const kind of ['Call', 'WhatsApp', 'Directions', 'Website']) await person.click(screen.getByRole('button', { name: `Add a ${kind} button` }));
    await person.click(screen.getByRole('button', { name: 'Save and close' }));
    await screen.findByText(/things to fix before these buttons can be saved/);
    await expectNoProblems();
  });

  it('the schedule step, as an hour grid and as a list of times', async () => {
    renderPortalAt(`/stations/${stationId}/ads/${draftAd.id}/setup?step=schedule`);
    await screen.findByRole('heading', { level: 1, name: 'Set when it airs' });
    await expectNoProblems();

    await person.click(screen.getByRole('button', { name: 'List of times' }));
    await screen.findByRole('listitem', { name: 'Time slot 1' });
    await expectNoProblems();
  });

  it('the review, ready to publish and with the question before publishing', async () => {
    renderPortalAt(`/stations/${stationId}/ads/${draftAd.id}/setup?step=review`);
    await screen.findByText('Ready to publish');
    await expectNoProblems();

    await person.click(screen.getByRole('button', { name: 'Publish' }));
    await screen.findByRole('dialog');
    await expectNoProblems();
  });

  it('the review of an ad that is not ready', async () => {
    renderPortalAt(`/stations/${stationId}/ads/${bareAd.id}/setup?step=review`);
    const notice = await screen.findByRole('alert');
    expect(within(notice).getByText('Not ready to publish yet')).toBeInTheDocument();
    await expectNoProblems();
  });
});
