import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../app/portal-api';
import type { ListenerFigures } from '@lookup/contracts';
import { adSummary, campaignSummary, listenerFigures, overviewFor, viewCounts } from '../../test/ad-fixtures';
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

function installOverview(overview: ReturnType<typeof overviewFor>, clients: unknown[] = [], figures: (range: string) => ListenerFigures = () => listenerFigures()) {
  return installFakeApi({
    'GET /auth/me': () => jsonResponse(200, owner),
    [`GET /stations/${stationId}/overview`]: () => jsonResponse(200, overview),
    [`GET /stations/${stationId}/clients`]: () => jsonResponse(200, clients),
    [`GET /stations/${stationId}/listener-figures`]: (_body, { searchParams }) => jsonResponse(200, figures(searchParams.get('range') ?? '')),
  });
}

/** Each key number as [title, value, note]. */
async function keyNumbers() {
  const list = await screen.findByLabelText('Key numbers');
  return [...list.querySelectorAll(':scope > div')].map((tile) => [...tile.children].map((part) => part.textContent));
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

  it('P5B-OVERVIEW-01, -04, -05, -06, -07: the heading and its line, then five key numbers with their titles and notes, in tabular figures', async () => {
    installOverview(overviewFor([]), [], () => listenerFigures({ recognitionsToday: 3, recognitions: 120, recognitionsSentLater: 30, buttonTaps: 30 }));
    renderPortalAt(overviewPath);
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByText('How listeners are responding to your ads')).toBeInTheDocument();
    await screen.findByText('120');
    expect(await keyNumbers()).toEqual([
      ['Recognitions today', '3', 'Listeners who identified one of your ads'],
      ['Recognitions · 7 days', '120', 'Includes clips sent later from no-signal areas'],
      ['Button taps · 7 days', '30', 'Calls, chats, directions and links'],
      ['Tap rate · 7 days', '25 %', 'Taps per recognition'],
      ['Sent later · 7 days', '25 %', 'Heard where there was no signal, sent once there was'],
    ]);
    for (const value of ['3', '120', '30']) expect(screen.getByText(value, { selector: 'dd' })).toHaveClass('tabular-nums');
  });

  it('P5B-OVERVIEW-02: the Date range offers Today, Last 7 days (chosen first) and Last 30 days; choosing one asks for it and keeps it in the address', async () => {
    const fakeApi = installOverview(overviewFor([]), [], (range) => listenerFigures({ range: range as ListenerFigures['range'], recognitions: range === 'last30Days' ? 400 : 120 }));
    const { router } = renderPortalAt(overviewPath);
    const select = await screen.findByRole('combobox', { name: 'Date range' });
    expect([...(select as HTMLSelectElement).options].map((option) => option.textContent)).toEqual(['Today', 'Last 7 days', 'Last 30 days']);
    expect(select).toHaveValue('last7Days');
    expect(await screen.findByText('Recognitions · 7 days')).toBeInTheDocument();
    await person.selectOptions(select, 'last30Days');
    expect(await screen.findByText('Recognitions · 30 days')).toBeInTheDocument();
    expect(screen.getByText('400')).toBeInTheDocument();
    expect(fakeApi.calls.some((call) => call.path === `/stations/${stationId}/listener-figures?range=last30Days`)).toBe(true);
    expect(router.state.location.search).toBe('?range=last30Days');
  });

  it('P5B-OVERVIEW-13, -14, -16: recognitions by hour as 24 bars hidden from screen readers, labelled 00:00 to 23:00, and as a table of the same numbers', async () => {
    const byHour = Array.from({ length: 24 }, (_unused, hour) => (hour === 7 ? 12 : hour === 17 ? 9 : hour % 3));
    installOverview(overviewFor([]), [], () => listenerFigures({ recognitions: byHour.reduce((sum, count) => sum + count, 0), recognitionsByHour: byHour }));
    renderPortalAt(overviewPath);
    const chart = await screen.findByRole('region', { name: 'Recognitions by hour' });
    const bars = chart.querySelectorAll('[data-hour]');
    expect(bars).toHaveLength(24);
    expect(bars[0]?.closest('[aria-hidden="true"]')).not.toBeNull();
    expect((bars[7] as HTMLElement).style.height).toBe('100%');
    for (const label of ['00:00', '06:00', '12:00', '18:00', '23:00']) expect(within(chart).getByText(label)).toBeInTheDocument();
    expect(within(chart).getByRole('button', { name: 'Chart' })).toHaveAttribute('aria-pressed', 'true');

    await person.click(within(chart).getByRole('button', { name: 'Table' }));
    expect(within(chart).getByRole('button', { name: 'Table' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(chart).getByRole('button', { name: 'Chart' })).toHaveAttribute('aria-pressed', 'false');
    const rows = within(within(chart).getByRole('table')).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(24);
    expect(rows.map((row) => within(row).getByRole('cell').textContent)).toEqual(byHour.map(String));
    expect(within(rows[7] as HTMLElement).getByRole('rowheader')).toHaveTextContent('07:00–08:00');
    expect(within(rows[23] as HTMLElement).getByRole('rowheader')).toHaveTextContent('23:00–00:00');
  });

  it('before any listener: zeros, a dash for the rates rather than a made-up percentage, and when the numbers will appear', async () => {
    installOverview(overviewFor([]));
    renderPortalAt(overviewPath);
    expect(await screen.findByText('Numbers appear here as listeners identify your ads in the Look Up app.')).toBeInTheDocument();
    const tiles = await keyNumbers();
    expect(tiles.map((tile) => tile[1])).toEqual(['0', '0', '0', '—', '—']);
  });

  it('explains a failure to load the numbers with its reference, and tries again on request', async () => {
    let attempts = 0;
    installFakeApi({
      'GET /auth/me': () => jsonResponse(200, owner),
      [`GET /stations/${stationId}/clients`]: () => jsonResponse(200, []),
      [`GET /stations/${stationId}/overview`]: () => jsonResponse(200, overviewFor([])),
      [`GET /stations/${stationId}/listener-figures`]: () => {
        attempts += 1;
        return attempts === 1 ? errorResponse(500, 'INTERNAL', 'Something went wrong on our side.', 'f1guresa') : jsonResponse(200, listenerFigures({ recognitions: 5 }));
      },
    });
    renderPortalAt(overviewPath);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("We couldn't load how listeners responded");
    expect(alert).toHaveTextContent('Reference: f1guresa');
    expect(document.body.textContent).not.toMatch(INTERNAL_DETAIL_PATTERN);
    await person.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('5')).toBeInTheDocument();
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
      [`GET /stations/${stationId}/listener-figures`]: () => jsonResponse(200, listenerFigures()),
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
