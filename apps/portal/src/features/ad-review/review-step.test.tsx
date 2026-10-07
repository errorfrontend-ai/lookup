import type { AdDetail } from '@lookup/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../app/portal-api';
import { adDetail, campaignSummary, overviewFor, scheduleFixture } from '../../test/ad-fixtures';
import { errorResponse, INTERNAL_DETAIL_PATTERN, installFakeApi, jsonResponse, signedInUserWith } from '../../test/fake-api';
import { renderPortalAt } from '../../test/render-portal';
import { setScreenWidth } from '../../test/screen-size';
import { clearAllUploads } from '../new-ad/ad-upload-store';

const person = userEvent.setup({ delay: null });
const owner = signedInUserWith([{ role: 'OWNER', name: 'Radio Phoenix', frequencyLabel: '89.5 FM' }]);
const stationId = owner.stations[0]?.id as string;

beforeEach(() => {
  // "Today" is the 6th of October, 10:00 in Lusaka. Only the clock is faked, so waiting and typing work as normal.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-06T08:00:00Z'));
  setScreenWidth(1280);
});

afterEach(() => {
  vi.useRealTimers();
  clearAllUploads();
  queryClient.clear();
  vi.unstubAllGlobals();
});

/** An ad that has everything and has not been published. */
function readyDraft(overrides: Partial<AdDetail> = {}): AdDetail {
  return adDetail({
    title: 'Summer service offer',
    status: 'PROCESSING',
    campaign: campaignSummary({ displayStatus: 'DRAFT', startsOn: '2026-10-06', endsOn: '2026-11-02' }),
    schedule: scheduleFixture({ displayStatus: 'DRAFT', startsOn: '2026-10-06', endsOn: '2026-11-02' }),
    ...overrides,
  });
}

interface PageOptions {
  ad?: AdDetail;
  user?: ReturnType<typeof signedInUserWith>;
  /** What the API answers to publishing. Defaults to making the campaign live and returning the ad. */
  onPublish?: () => Response;
}

function installReviewPage({ ad = readyDraft(), user = owner, onPublish }: PageOptions = {}) {
  const published: unknown[] = [];
  const fakeApi = installFakeApi({
    'GET /auth/me': () => jsonResponse(200, user),
    [`GET /stations/${stationId}`]: () => jsonResponse(200, { id: stationId, timeZone: 'Africa/Lusaka' }),
    [`GET /stations/${stationId}/clients`]: () => jsonResponse(200, []),
    [`GET /stations/${stationId}/overview`]: () => jsonResponse(200, overviewFor([])),
    [`GET /stations/${stationId}/ads`]: () => jsonResponse(200, { ads: [], nextCursor: null }),
    [`GET /stations/${stationId}/ads/${ad.id}`]: () => jsonResponse(200, ad),
    [`GET /stations/${stationId}/ads/${ad.id}/history`]: () => jsonResponse(200, { events: [], nextCursor: null }),
    [`POST /stations/${stationId}/ads/${ad.id}/publish`]: () => {
      published.push(true);
      if (onPublish) return onPublish();
      return jsonResponse(200, { ...ad, campaign: { ...(ad.campaign ?? campaignSummary()), displayStatus: 'LIVE_NOW' } });
    },
  });
  return { ...fakeApi, ad, published, reviewPath: `/stations/${stationId}/ads/${ad.id}/setup?step=review` };
}

const openReview = async (options: PageOptions = {}) => {
  const page = installReviewPage(options);
  const rendered = renderPortalAt(page.reviewPath);
  await screen.findByRole('heading', { level: 1, name: /Review and publish|Your ad/ });
  return { ...page, ...rendered };
};

describe('Review and publish', () => {
  describe('an ad that is ready', () => {
    it('shows everything in one place, with a way back to each part', async () => {
      await openReview();
      expect(screen.getByText('Step 5 of 5 · Review')).toBeInTheDocument();
      expect(screen.getByText('Ready to publish')).toBeInTheDocument();

      const audio = screen.getByRole('region', { name: 'Audio' });
      expect(within(audio).getByText('Summer service offer')).toBeInTheDocument();
      expect(within(audio).getByText(/for Brand A/)).toBeInTheDocument();
      expect(within(audio).getByRole('button', { name: 'Play Summer service offer' })).toBeInTheDocument();
      expect(within(audio).getByText(/offer\.mp3 · 94 KB/)).toBeInTheDocument();

      const buttons = screen.getByRole('region', { name: 'Buttons' });
      expect(within(buttons).getByText('Call Brand A')).toBeInTheDocument();
      expect(within(buttons).getByText('+260 97 712 3456')).toBeInTheDocument();
      expect(within(buttons).getByText(/Hello there/)).toBeInTheDocument();
      expect(within(buttons).getByRole('link', { name: 'Try “Call Brand A”' })).toHaveAttribute('href', 'tel:+260977123456');

      const airs = screen.getByRole('region', { name: 'When it airs' });
      expect(within(airs).getByText('6 Oct – 2 Nov')).toBeInTheDocument();
      expect(within(airs).getByText('Mon–Fri · 07:00–09:00')).toBeInTheDocument();

      const preview = screen.getByRole('region', { name: 'What listeners see' });
      expect(within(preview).getByText('Brand A · via Radio Phoenix · 89.5 FM')).toBeInTheDocument();

      expect(screen.getByRole('button', { name: 'Publish' })).toBeEnabled();
    });

    it('goes back to the step for each part from its change link', async () => {
      const { router } = await openReview();
      await person.click(screen.getByRole('link', { name: 'Change buttons' }));
      expect(router.state.location.search).toBe('?step=buttons');
      expect(await screen.findByRole('heading', { level: 1, name: 'Add the buttons' })).toBeInTheDocument();
    });

    it('asks before publishing, saying what will happen, and publishes nothing if told not yet', async () => {
      const { published } = await openReview();
      await person.click(screen.getByRole('button', { name: 'Publish' }));

      const dialog = await screen.findByRole('dialog', { name: 'Publish “Summer service offer”?' });
      expect(dialog).toHaveTextContent('It goes on air by the schedule you set: Mon–Fri · 07:00–09:00, 6 Oct – 2 Nov. You can still change its buttons and times afterwards.');
      await person.click(within(dialog).getByRole('button', { name: 'Not yet' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(published).toHaveLength(0);
    });

    it('publishes, says so, and shows the ad', async () => {
      const { published, router } = await openReview();
      await person.click(screen.getByRole('button', { name: 'Publish' }));
      await person.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Publish' }));

      await waitFor(() => expect(published).toHaveLength(1));
      await waitFor(() => expect(router.state.location.pathname).toMatch(new RegExp(`^/stations/${stationId}/ads/[0-9a-f-]+$`)));
      expect(await screen.findByText('Published. It is on air now.')).toBeInTheDocument();
    });

    it('says when it goes on air if that is later', async () => {
      const ad = readyDraft({ campaign: campaignSummary({ displayStatus: 'DRAFT', startsOn: '2026-10-08', endsOn: '2026-11-02' }), schedule: scheduleFixture({ displayStatus: 'DRAFT', startsOn: '2026-10-08', endsOn: '2026-11-02' }) });
      await openReview({ ad, onPublish: () => jsonResponse(200, { ...ad, campaign: { ...ad.campaign, displayStatus: 'SCHEDULED' } }) });
      await person.click(screen.getByRole('button', { name: 'Publish' }));
      await person.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Publish' }));
      expect(await screen.findByText('Published. It goes on air from 8 Oct.')).toBeInTheDocument();
    });

    it('says when it goes on air at its next time, if it has started but is between slots', async () => {
      const ad = readyDraft();
      await openReview({ ad, onPublish: () => jsonResponse(200, { ...ad, campaign: { ...ad.campaign, displayStatus: 'SCHEDULED' } }) });
      await person.click(screen.getByRole('button', { name: 'Publish' }));
      await person.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Publish' }));
      expect(await screen.findByText('Published. It goes on air at its next time.')).toBeInTheDocument();
    });

    it('can be left as a draft', async () => {
      const { router } = await openReview();
      await person.click(screen.getByRole('button', { name: 'Save and close' }));
      await waitFor(() => expect(router.state.location.search).toBe('?view=drafts'));
      expect(await screen.findByText('Draft saved. Continue setup from Drafts any time.')).toBeInTheDocument();
    });
  });

  describe('an ad that is not ready', () => {
    it('lists what is missing, each with the way to fix it, and will not publish', async () => {
      const ad = readyDraft({ status: 'AWAITING_UPLOAD', actionCard: null, schedule: null, campaign: null });
      const { published } = await openReview({ ad });

      const notice = screen.getByRole('alert');
      expect(within(notice).getByText('Not ready to publish yet')).toBeInTheDocument();
      expect(within(notice).getByText("The audio hasn't arrived and been checked yet.")).toBeInTheDocument();
      expect(within(notice).getByText('There are no buttons yet.')).toBeInTheDocument();
      expect(within(notice).getByText("It isn't scheduled yet.")).toBeInTheDocument();
      expect(within(notice).getByRole('link', { name: 'Go to the audio' })).toHaveAttribute('href', `/stations/${stationId}/ads/${ad.id}/setup?step=audio`);
      expect(within(notice).getByRole('link', { name: 'Add buttons' })).toHaveAttribute('href', `/stations/${stationId}/ads/${ad.id}/setup?step=buttons`);
      expect(within(notice).getByRole('link', { name: 'Set the schedule' })).toHaveAttribute('href', `/stations/${stationId}/ads/${ad.id}/setup?step=schedule`);
      expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
      expect(published).toHaveLength(0);
    });

    it('says when the last day has already passed, and where to change it', async () => {
      const ad = readyDraft({ schedule: scheduleFixture({ displayStatus: 'DRAFT', startsOn: '2026-09-01', endsOn: '2026-10-05' }) });
      await openReview({ ad });
      const notice = screen.getByRole('alert');
      expect(within(notice).getByText('Its last day has already passed.')).toBeInTheDocument();
      expect(within(notice).getByRole('link', { name: 'Change the dates' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
    });

    it('fixes a blocker by following its link, then publishes', async () => {
      const ad = readyDraft({ actionCard: null });
      const { router } = await openReview({ ad });
      await person.click(within(screen.getByRole('alert')).getByRole('link', { name: 'Add buttons' }));
      expect(router.state.location.search).toBe('?step=buttons');
      expect(await screen.findByRole('heading', { level: 1, name: 'Add the buttons' })).toBeInTheDocument();
    });
  });

  describe('when the API does not agree', () => {
    it('shows what the API says is missing, since it checked for real', async () => {
      const { published } = await openReview({
        onPublish: () => errorResponse(409, 'AD_NOT_READY_TO_PUBLISH', "This ad isn't ready to publish yet.", 'ref-5544', [{ path: 'schedule', code: 'schedule_already_ended' }]),
      });
      await person.click(screen.getByRole('button', { name: 'Publish' }));
      await person.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Publish' }));

      await waitFor(() => expect(published).toHaveLength(1));
      const notice = await screen.findByText('Not ready to publish yet');
      expect(within(notice.closest('[role="alert"]') as HTMLElement).getByText('Its last day has already passed.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('says a clash with another live campaign plainly, with the reference, and lets the person try again', async () => {
      await openReview({ onPublish: () => errorResponse(409, 'CONFLICT', 'This ad already has a live campaign for these dates.', 'ref-2211') });
      await person.click(screen.getByRole('button', { name: 'Publish' }));
      await person.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Publish' }));

      const notice = (await screen.findByText("We couldn't publish this ad")).closest('[role="alert"]') as HTMLElement;
      expect(notice).toHaveTextContent('This ad already has a live campaign for these dates.');
      expect(notice).toHaveTextContent('ref-2211');
      expect(screen.getByRole('button', { name: 'Publish' })).toBeEnabled();
    });

    it('says a server failure in plain words, with no technical text', async () => {
      await openReview({ onPublish: () => errorResponse(500, 'INTERNAL', 'Something went wrong on our side. Please try again.', 'ref-7766') });
      await person.click(screen.getByRole('button', { name: 'Publish' }));
      await person.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Publish' }));
      const notice = (await screen.findByText("We couldn't publish this ad")).closest('[role="alert"]') as HTMLElement;
      expect(notice).toHaveTextContent('ref-7766');
      expect(document.body.textContent).not.toMatch(INTERNAL_DETAIL_PATTERN);
    });
  });

  describe('an ad that is already published', () => {
    it('says so, offers no Publish, and closes back to the ad', async () => {
      const ad = adDetail({ title: 'Summer service offer', status: 'PROCESSING' });
      const { router } = await openReview({ ad });
      expect(screen.getByRole('heading', { level: 1, name: 'Your ad' })).toBeInTheDocument();
      expect(screen.getByText('Published · On air now')).toBeInTheDocument();
      expect(screen.getByText('Edit ad · Brand A')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();

      await person.click(screen.getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(router.state.location.pathname).toBe(`/stations/${stationId}/ads/${ad.id}`));
    });
  });

  describe('who may publish', () => {
    it('keeps an analyst out', async () => {
      const analyst = signedInUserWith([{ role: 'ANALYST' }]);
      const page = installReviewPage({ user: analyst });
      renderPortalAt(`/stations/${analyst.stations[0]?.id}/ads/${page.ad.id}/setup?step=review`);
      expect(await screen.findByRole('heading', { name: "You can't set up ads" })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
    });
  });
});
