import type { AdSummary } from '@lookup/contracts';
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../app/portal-api';
import { adSummary, campaignSummary, overviewFor } from '../../test/ad-fixtures';
import { installFakeApi, jsonResponse, signedInUserWith } from '../../test/fake-api';
import { renderPortalAt } from '../../test/render-portal';
import { setWideScreen } from '../../test/screen-size';

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
});

const owner = signedInUserWith([{ role: 'OWNER' }]);
const analyst = signedInUserWith([{ role: 'ANALYST' }]);
const waiting = signedInUserWith([{ role: 'OWNER', status: 'PENDING_REVIEW' }]);

function installStation(user: ReturnType<typeof signedInUserWith>, ads: AdSummary[]) {
  const stationId = user.stations[0]?.id as string;
  installFakeApi({
    'GET /auth/me': () => jsonResponse(200, user),
    [`GET /stations/${stationId}/overview`]: () => jsonResponse(200, overviewFor(ads)),
    [`GET /stations/${stationId}/clients`]: () => jsonResponse(200, []),
    [`GET /stations/${stationId}/ads`]: () => jsonResponse(200, { ads, nextCursor: null }),
  });
  return stationId;
}

describe('the way into setting up an ad', () => {
  describe('Upload ad', () => {
    it('is in the header of the Ads page and of the Overview for an owner, and leads to the wizard', async () => {
      const stationId = installStation(owner, [adSummary()]);
      const { unmount } = renderPortalAt(`/stations/${stationId}/ads`);
      expect(await screen.findByRole('link', { name: 'Upload ad' })).toHaveAttribute('href', `/stations/${stationId}/ads/new`);
      unmount();

      renderPortalAt(`/stations/${stationId}/overview`);
      expect(await screen.findByRole('link', { name: 'Upload ad' })).toHaveAttribute('href', `/stations/${stationId}/ads/new`);
    });

    it('is offered in the empty list as "Upload your first ad"', async () => {
      const stationId = installStation(owner, []);
      renderPortalAt(`/stations/${stationId}/ads`);
      expect(await screen.findByRole('link', { name: 'Upload your first ad' })).toHaveAttribute('href', `/stations/${stationId}/ads/new`);
    });

    it('is on the getting-started step of a new station, once there is a way to do it', async () => {
      const stationId = installStation(owner, []);
      renderPortalAt(`/stations/${stationId}/overview`);
      const gettingStarted = await screen.findByRole('region', { name: 'Getting started' });
      expect(within(gettingStarted).getByRole('link', { name: 'Upload their ad' })).toHaveAttribute('href', `/stations/${stationId}/ads/new`);
    });

    it('is not shown to an analyst, who cannot set ads up', async () => {
      const stationId = installStation(analyst, []);
      const { unmount } = renderPortalAt(`/stations/${stationId}/ads`);
      await screen.findByText('Ads appear here once an owner or manager uploads them.');
      expect(screen.queryByRole('link', { name: /Upload/ })).not.toBeInTheDocument();
      unmount();

      renderPortalAt(`/stations/${stationId}/overview`);
      await screen.findByRole('region', { name: 'Getting started' });
      expect(screen.queryByRole('link', { name: /Upload/ })).not.toBeInTheDocument();
      expect(screen.getByText(/Upload their ad/)).toBeInTheDocument();
    });

    it('is not shown while the station is still under review', async () => {
      const stationId = installStation(waiting, []);
      renderPortalAt(`/stations/${stationId}/profile`);
      await screen.findByRole('heading', { level: 1, name: 'Station profile' });
      expect(screen.queryByRole('link', { name: /Upload/ })).not.toBeInTheDocument();
    });
  });

  describe('Continue setup', () => {
    const unfinished = adSummary({ title: 'Half done', status: 'AWAITING_UPLOAD', uploadedFileName: null, campaign: null, hasActionCard: false });
    const refused = adSummary({ title: 'Refused file', status: 'FAILED', campaign: null, hasActionCard: false, attentionReasons: ['upload_refused'] });
    const finished = adSummary({ title: 'All good', status: 'PROCESSING' });

    it('is on an ad whose audio never arrived, in the table, and goes back to its audio step', async () => {
      setWideScreen(true);
      const stationId = installStation(owner, [unfinished, finished]);
      renderPortalAt(`/stations/${stationId}/ads`);

      const link = await screen.findByRole('link', { name: 'Continue setup: Half done' });
      expect(link).toHaveAttribute('href', `/stations/${stationId}/ads/${unfinished.id}/setup?step=audio`);
      expect(screen.getAllByRole('link', { name: /Continue setup|Upload again/ })).toHaveLength(1);
    });

    it('says "Upload again" for a refused file, and appears on phone cards too', async () => {
      const stationId = installStation(owner, [refused, finished]);
      renderPortalAt(`/stations/${stationId}/ads`);

      const link = await screen.findByRole('link', { name: 'Upload again: Refused file' });
      expect(link).toHaveAttribute('href', `/stations/${stationId}/ads/${refused.id}/setup?step=audio`);
      expect(link).toHaveTextContent('Upload again');
    });

    it('goes to the buttons for an ad whose audio is in but has none yet', async () => {
      const noButtons = adSummary({ title: 'No buttons', status: 'PROCESSING', hasActionCard: false, campaign: null });
      const stationId = installStation(owner, [noButtons]);
      renderPortalAt(`/stations/${stationId}/ads`);
      const link = await screen.findByRole('link', { name: 'Continue setup: No buttons' });
      expect(link).toHaveAttribute('href', `/stations/${stationId}/ads/${noButtons.id}/setup?step=buttons`);
    });

    it('goes to the schedule for an ad with buttons that has no times yet', async () => {
      const needsSchedule = adSummary({ title: 'Needs a schedule', status: 'PROCESSING', hasActionCard: true, campaign: null });
      const stationId = installStation(owner, [needsSchedule]);
      renderPortalAt(`/stations/${stationId}/ads`);
      const link = await screen.findByRole('link', { name: 'Continue setup: Needs a schedule' });
      expect(link).toHaveAttribute('href', `/stations/${stationId}/ads/${needsSchedule.id}/setup?step=schedule`);
    });

    it('goes to the review for an ad with buttons and a schedule that is not published', async () => {
      const readyToReview = adSummary({ title: 'Ready to review', status: 'PROCESSING', hasActionCard: true, campaign: campaignSummary({ displayStatus: 'DRAFT' }) });
      const stationId = installStation(owner, [readyToReview]);
      renderPortalAt(`/stations/${stationId}/ads`);
      const link = await screen.findByRole('link', { name: 'Continue setup: Ready to review' });
      expect(link).toHaveAttribute('href', `/stations/${stationId}/ads/${readyToReview.id}/setup?step=review`);
    });

    it('is not shown for an ad that is published and has nothing wrong', async () => {
      const live = adSummary({ title: 'Weekday spot', status: 'PROCESSING', hasActionCard: true });
      const stationId = installStation(owner, [live]);
      renderPortalAt(`/stations/${stationId}/ads`);
      await screen.findByText('Weekday spot');
      expect(screen.queryByRole('link', { name: /Continue setup|Upload again|Review and publish|Extend/ })).not.toBeInTheDocument();
    });

    it('says what to do about a problem: review and publish a draft that should have started, extend an ad that ends soon', async () => {
      const lateDraft = adSummary({ title: 'Late draft', status: 'PROCESSING', hasActionCard: true, campaign: campaignSummary({ displayStatus: 'DRAFT' }), attentionReasons: ['start_date_passed'] });
      const endsSoon = adSummary({ title: 'Ends soon', status: 'PROCESSING', hasActionCard: true, attentionReasons: ['ending_soon'] });
      const stationId = installStation(owner, [lateDraft, endsSoon]);
      renderPortalAt(`/stations/${stationId}/ads`);
      expect(await screen.findByRole('link', { name: 'Review and publish: Late draft' })).toHaveAttribute('href', `/stations/${stationId}/ads/${lateDraft.id}/setup?step=review`);
      expect(screen.getByRole('link', { name: 'Extend the dates: Ends soon' })).toHaveAttribute('href', `/stations/${stationId}/ads/${endsSoon.id}/setup?step=schedule`);
    });

    it('is not shown to an analyst', async () => {
      const stationId = installStation(analyst, [unfinished, refused]);
      renderPortalAt(`/stations/${stationId}/ads`);
      await screen.findByText('Half done');
      expect(screen.queryByRole('link', { name: /Continue setup|Upload again/ })).not.toBeInTheDocument();
    });
  });
});
