import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../app/portal-api';
import { adSummary, campaignSummary, overviewFor, viewCounts } from '../../test/ad-fixtures';
import { errorResponse, INTERNAL_DETAIL_PATTERN, installFakeApi, jsonResponse, signedInUserWith } from '../../test/fake-api';
import { renderPortalAt } from '../../test/render-portal';

const person = userEvent.setup({ delay: null });
const owner = signedInUserWith([{ role: 'OWNER', name: 'Radio Phoenix', frequencyLabel: '89.5 FM' }]);
const stationId = owner.stations[0]?.id as string;
const overviewPath = `/stations/${stationId}/overview`;

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
});

function installOverview(overview: ReturnType<typeof overviewFor>, clients: unknown[] = []) {
  return installFakeApi({
    'GET /auth/me': () => jsonResponse(200, owner),
    [`GET /stations/${stationId}/overview`]: () => jsonResponse(200, overview),
    [`GET /stations/${stationId}/clients`]: () => jsonResponse(200, clients),
  });
}

describe('Overview', () => {
  it('counts the ads under each tab, and each count links to that tab', async () => {
    installOverview({ ...overviewFor([]), adCounts: viewCounts({ all: 9, live: 2, scheduled: 3, drafts: 4, attention: 1 }) });
    renderPortalAt(overviewPath);

    const glance = await screen.findByRole('region', { name: 'Your ads at a glance' });
    const links = within(glance).getAllByRole('link');
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['On air now2', `/stations/${stationId}/ads?view=live`],
      ['Scheduled3', `/stations/${stationId}/ads?view=scheduled`],
      ['Drafts4', `/stations/${stationId}/ads?view=drafts`],
      ['Needs attention1', `/stations/${stationId}/ads?view=attention`],
    ]);
  });

  it('lists what is on air, with its schedule, and what needs attention, in words', async () => {
    const summer = adSummary({ title: 'Summer service offer', campaign: campaignSummary({ displayStatus: 'LIVE_NOW', startsOn: '2026-10-01', endsOn: '2026-10-31' }) });
    const refused = adSummary({ title: 'Festive greetings', client: { id: 'x', name: 'Brand B' }, status: 'FAILED', campaign: null, attentionReasons: ['upload_refused'] });
    installOverview(overviewFor([summer, refused]));
    renderPortalAt(overviewPath);

    const onAir = await screen.findByRole('region', { name: 'On air now' });
    expect(within(onAir).getByText('Summer service offer')).toBeInTheDocument();
    expect(within(onAir).getByText(/Brand A · Mon–Fri · 07:00–09:00 · 1 – 31 Oct/)).toBeInTheDocument();
    expect(within(onAir).getByRole('heading', { name: 'On air now' })).toBeInTheDocument();
    expect(within(onAir).getAllByText('On air now')).toHaveLength(2); // the heading and the ON AIR badge

    const attention = screen.getByRole('region', { name: 'Needs attention' });
    expect(within(attention).getByText('Brand B · upload refused')).toBeInTheDocument();
    expect(within(attention).getByText(/Festive greetings · The audio couldn't be used\./)).toBeInTheDocument();
    expect(within(attention).getByRole('link', { name: 'See all in Ads' })).toHaveAttribute('href', `/stations/${stationId}/ads?view=attention`);
  });

  it('says what to do about each problem, with a link to the step that fixes it', async () => {
    const refused = adSummary({ title: 'Festive greetings', status: 'FAILED', campaign: null, attentionReasons: ['upload_refused'] });
    const lateDraft = adSummary({ title: 'Late draft', hasActionCard: true, campaign: campaignSummary({ displayStatus: 'DRAFT' }), attentionReasons: ['start_date_passed'] });
    const endsSoon = adSummary({ title: 'Ends soon', campaign: campaignSummary({ displayStatus: 'LIVE_NOW' }), attentionReasons: ['ending_soon'] });
    const checking = adSummary({ title: 'Being checked', status: 'NEEDS_REVIEW', attentionReasons: ['needs_review'] });
    installOverview(overviewFor([refused, lateDraft, endsSoon, checking]));
    renderPortalAt(overviewPath);

    const attention = await screen.findByRole('region', { name: 'Needs attention' });
    const adPath = (ad: { id: string }) => `/stations/${stationId}/ads/${ad.id}`;
    expect(within(attention).getByRole('link', { name: 'Upload again: Festive greetings' })).toHaveAttribute('href', `${adPath(refused)}/setup?step=audio`);
    expect(within(attention).getByRole('link', { name: 'Review and publish: Late draft' })).toHaveAttribute('href', `${adPath(lateDraft)}/setup?step=review`);
    expect(within(attention).getByRole('link', { name: 'Extend the dates: Ends soon' })).toHaveAttribute('href', `${adPath(endsSoon)}/setup?step=schedule`);
    // Look Up's own check is not the station's to fix: it just opens the ad.
    expect(within(attention).getByRole('link', { name: 'View ad: Being checked' })).toHaveAttribute('href', adPath(checking));
  });

  it('only opens the ad for someone who cannot change ads', async () => {
    const analyst = signedInUserWith([{ role: 'ANALYST', name: 'Radio Phoenix', frequencyLabel: '89.5 FM' }]);
    const analystStation = analyst.stations[0]?.id as string;
    const refused = adSummary({ title: 'Festive greetings', status: 'FAILED', campaign: null, attentionReasons: ['upload_refused'] });
    installFakeApi({
      'GET /auth/me': () => jsonResponse(200, analyst),
      [`GET /stations/${analystStation}/overview`]: () => jsonResponse(200, overviewFor([refused])),
      [`GET /stations/${analystStation}/clients`]: () => jsonResponse(200, []),
    });
    renderPortalAt(`/stations/${analystStation}/overview`);
    const attention = await screen.findByRole('region', { name: 'Needs attention' });
    expect(within(attention).getByRole('link', { name: 'View ad: Festive greetings' })).toHaveAttribute('href', `/stations/${analystStation}/ads/${refused.id}`);
    expect(within(attention).queryByRole('link', { name: /Upload again/ })).not.toBeInTheDocument();
  });

  it('says plainly when nothing is on air and nothing needs attention', async () => {
    installOverview(overviewFor([adSummary({ campaign: campaignSummary({ displayStatus: 'SCHEDULED' }) })]));
    renderPortalAt(overviewPath);
    expect(await screen.findByText('Nothing is on air right now.')).toBeInTheDocument();
    expect(screen.getByText('Nothing needs your attention.')).toBeInTheDocument();
  });

  it('does not invent numbers about listeners: it says when they will appear', async () => {
    installOverview(overviewFor([]));
    renderPortalAt(overviewPath);
    const recognition = await screen.findByRole('region', { name: 'Recognition' });
    expect(within(recognition).getByText(/Once listeners can identify your ads/)).toBeInTheDocument();
    expect(within(recognition).queryByText(/\d/)).not.toBeInTheDocument();
  });

  it('a station with no ads is shown how to start, and ticks off the first step once it has a client', async () => {
    installOverview(overviewFor([]), []);
    const first = renderPortalAt(overviewPath);
    const steps = await screen.findByRole('region', { name: 'Getting started' });
    expect(within(steps).getByRole('link', { name: 'Add a client' })).toHaveAttribute('href', `/stations/${stationId}/clients`);
    expect(within(steps).getByText('1')).toBeInTheDocument();
    first.unmount();
    queryClient.clear();

    installOverview(overviewFor([]), [{ id: 'c1', name: 'Brand A', adCount: 0, liveNowAdCount: 0 }]);
    renderPortalAt(overviewPath);
    const stepsWithClient = await screen.findByRole('region', { name: 'Getting started' });
    expect(within(stepsWithClient).queryByText('1')).not.toBeInTheDocument();
  });

  it('explains a failure with its reference, and tries again on request', async () => {
    let attempts = 0;
    installFakeApi({
      'GET /auth/me': () => jsonResponse(200, owner),
      [`GET /stations/${stationId}/clients`]: () => jsonResponse(200, []),
      [`GET /stations/${stationId}/overview`]: () => {
        attempts += 1;
        return attempts === 1 ? errorResponse(500, 'INTERNAL', 'Something went wrong on our side.', 'abad1dea') : jsonResponse(200, overviewFor([]));
      },
    });
    renderPortalAt(overviewPath);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("We couldn't load your overview");
    expect(alert).toHaveTextContent('Reference: abad1dea');
    expect(document.body.textContent).not.toMatch(INTERNAL_DETAIL_PATTERN);
    await person.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: 'Your ads at a glance' })).toBeInTheDocument();
  });
});

describe('the "on air" indicator in the sidebar', () => {
  it('says how many ads are on air, and links to them', async () => {
    const live = [adSummary(), adSummary()];
    installOverview(overviewFor(live));
    renderPortalAt(overviewPath);
    const indicator = (await screen.findAllByRole('link', { name: 'On air now · 2 ads' }))[0] as HTMLElement;
    expect(indicator).toHaveAttribute('href', `/stations/${stationId}/ads?view=live`);
  });

  it('says one ad in the singular, and says so plainly when none are on air', async () => {
    installOverview(overviewFor([adSummary()]));
    const first = renderPortalAt(overviewPath);
    expect((await screen.findAllByRole('link', { name: 'On air now · 1 ad' }))[0]).toBeInTheDocument();
    first.unmount();
    queryClient.clear();

    installOverview(overviewFor([]));
    renderPortalAt(overviewPath);
    expect((await screen.findAllByText('Nothing on air right now'))[0]).toBeInTheDocument();
  });

  it('is not shown, and asks nothing of the server, for a station that is not approved', async () => {
    const underReview = signedInUserWith([{ status: 'PENDING_REVIEW' }]);
    const fakeApi = installFakeApi({ 'GET /auth/me': () => jsonResponse(200, underReview) });
    renderPortalAt(`/stations/${underReview.stations[0]?.id}/profile`);
    await screen.findAllByRole('navigation', { name: 'Main' });
    expect(fakeApi.calls.some((call) => call.path.includes('/overview'))).toBe(false);
    expect(screen.queryByText(/On air now/)).not.toBeInTheDocument();
  });
});
