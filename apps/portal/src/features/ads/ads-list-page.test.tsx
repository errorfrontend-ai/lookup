import type { AdListPage, AdSummary } from '@lookup/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../app/portal-api';
import { adSummary, campaignSummary, overviewFor } from '../../test/ad-fixtures';
import { errorResponse, INTERNAL_DETAIL_PATTERN, installFakeApi, jsonResponse, signedInUserWith } from '../../test/fake-api';
import { renderPortalAt } from '../../test/render-portal';
import { setWideScreen } from '../../test/screen-size';

const person = userEvent.setup({ delay: null });
const owner = signedInUserWith([{ role: 'OWNER' }]);
const stationId = owner.stations[0]?.id as string;
const adsPath = `/stations/${stationId}/ads`;
const brandA = { id: '0190f1a2-0000-7000-8000-0000000000a1', name: 'Brand A' };
const brandB = { id: '0190f1a2-0000-7000-8000-0000000000b2', name: 'Brand B' };

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The fake API for the ads page: the list answers with the pages given, in order. */
function installAds(pages: AdListPage[], options: { ads?: AdSummary[]; onList?: (searchParams: URLSearchParams) => void } = {}) {
  let pageNumber = 0;
  return installFakeApi({
    'GET /auth/me': () => jsonResponse(200, owner),
    [`GET /stations/${stationId}/overview`]: () => jsonResponse(200, overviewFor(options.ads ?? pages.flatMap((page) => page.ads))),
    [`GET /stations/${stationId}/clients`]: () =>
      jsonResponse(200, [
        { ...brandA, adCount: 2, liveNowAdCount: 1 },
        { ...brandB, adCount: 1, liveNowAdCount: 0 },
      ]),
    [`GET /stations/${stationId}/ads`]: (_body, request) => {
      options.onList?.(request.searchParams);
      const page = pages[Math.min(pageNumber, pages.length - 1)] as AdListPage;
      pageNumber += 1;
      return jsonResponse(200, page);
    },
  });
}

describe('Ads list', () => {
  describe('on a wide screen: a table', () => {
    it('shows each ad with its client, campaign, audio file, schedule, dates and when it changed', async () => {
      setWideScreen(true);
      const summer = adSummary({ title: 'Summer service offer', client: brandA, status: 'PROCESSING' });
      const weekend = adSummary({
        title: 'Weekend sale',
        client: brandB,
        campaign: campaignSummary({ displayStatus: 'SCHEDULED', startsOn: '2026-11-04', endsOn: '2026-11-26', timeWindows: [{ daysOfWeek: [6, 7], localStartTime: '10:00', localEndTime: '14:00' }] }),
        updatedAt: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
      });
      installAds([{ ads: [summer, weekend], nextCursor: null }]);
      renderPortalAt(adsPath);

      const table = await screen.findByRole('table', { name: 'Your ads' });
      expect(within(table).getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['Ad', 'Campaign', 'Audio', 'When it airs', 'Changed', 'Play']);
      const [summerRow, weekendRow] = within(table).getAllByRole('row').slice(1) as HTMLElement[];
      expect(within(summerRow as HTMLElement).getByRole('rowheader')).toHaveTextContent('Summer service offerBrand A');
      expect(within(summerRow as HTMLElement).getByText('On air now')).toBeInTheDocument();
      expect(within(summerRow as HTMLElement).getByText('Audio checked')).toBeInTheDocument();
      expect(within(summerRow as HTMLElement).getByText('Mon–Fri · 07:00–09:00')).toBeInTheDocument();
      expect(within(summerRow as HTMLElement).getByText('1 – 31 Oct')).toBeInTheDocument();
      expect(within(summerRow as HTMLElement).getByText('2 hours ago')).toBeInTheDocument();
      expect(within(weekendRow as HTMLElement).getByText('Scheduled')).toBeInTheDocument();
      expect(within(weekendRow as HTMLElement).getByText('Sat, Sun · 10:00–14:00')).toBeInTheDocument();
      expect(within(weekendRow as HTMLElement).getByText('4 – 26 Nov')).toBeInTheDocument();
      expect(within(weekendRow as HTMLElement).getByText('yesterday')).toBeInTheDocument();
      expect(screen.getByText('Showing 2 ads')).toBeInTheDocument();
    });
  });

  describe('on a phone: cards', () => {
    it('shows each ad as a card with its badges, schedule and a Play button', async () => {
      setWideScreen(false);
      const summer = adSummary({ title: 'Summer service offer', client: brandA });
      installAds([{ ads: [summer], nextCursor: null }]);
      renderPortalAt(adsPath);

      const card = (await screen.findByText('Summer service offer')).closest('article') as HTMLElement;
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      expect(within(card).getByText('Brand A')).toBeInTheDocument();
      expect(within(card).getByText('On air now')).toBeInTheDocument();
      expect(within(card).getByText('Audio checked')).toBeInTheDocument();
      expect(within(card).getByText('Mon–Fri · 07:00–09:00')).toBeInTheDocument();
      expect(within(card).getByText('Changed 2 hours ago')).toBeInTheDocument();
      expect(within(card).getByRole('button', { name: 'Play Summer service offer' })).toBeInTheDocument();
    });

    it('says in words why an ad needs attention, and offers no Play for audio that never arrived', async () => {
      setWideScreen(false);
      const refused = adSummary({ title: 'Festive greetings', status: 'FAILED', campaign: null, attentionReasons: ['upload_refused'] });
      const ending = adSummary({ title: 'Harvest festival', attentionReasons: ['ending_soon'], campaign: campaignSummary({ endsOn: '2026-10-07' }) });
      installAds([{ ads: [refused, ending], nextCursor: null }]);
      renderPortalAt(adsPath);

      const refusedCard = (await screen.findByText('Festive greetings')).closest('article') as HTMLElement;
      expect(within(refusedCard).getByText("The audio couldn't be used.")).toBeInTheDocument();
      expect(within(refusedCard).getByText('Upload refused')).toBeInTheDocument();
      expect(within(refusedCard).getByText('Not scheduled yet')).toBeInTheDocument();
      expect(within(refusedCard).queryByRole('button', { name: /^Play/ })).not.toBeInTheDocument();
      const endingCard = screen.getByText('Harvest festival').closest('article') as HTMLElement;
      expect(within(endingCard).getByText('Its last day is 7 Oct.')).toBeInTheDocument();
    });
  });

  describe('states', () => {
    it('shows a loading state, then a message that says what to expect when there are no ads', async () => {
      installAds([{ ads: [], nextCursor: null }]);
      renderPortalAt(adsPath);
      expect(await screen.findByRole('status', { name: 'Loading' })).toBeInTheDocument();
      expect(await screen.findByRole('heading', { name: 'No ads yet.' })).toBeInTheDocument();
      expect(screen.getByText(/Ads you upload for your clients appear here/)).toBeInTheDocument();
    });

    it('tells an analyst that ads come from owners and managers', async () => {
      const analyst = signedInUserWith([{ role: 'ANALYST' }]);
      const analystStationId = analyst.stations[0]?.id as string;
      installFakeApi({
        'GET /auth/me': () => jsonResponse(200, analyst),
        [`GET /stations/${analystStationId}/overview`]: () => jsonResponse(200, overviewFor([])),
        [`GET /stations/${analystStationId}/clients`]: () => jsonResponse(200, []),
        [`GET /stations/${analystStationId}/ads`]: () => jsonResponse(200, { ads: [], nextCursor: null }),
      });
      renderPortalAt(`/stations/${analystStationId}/ads`);
      expect(await screen.findByText('Ads appear here once an owner or manager uploads them.')).toBeInTheDocument();
    });

    it('each empty tab says what it means', async () => {
      installAds([{ ads: [], nextCursor: null }]);
      renderPortalAt(`${adsPath}?view=live`);
      expect(await screen.findByRole('heading', { name: 'Nothing is on air right now.' })).toBeInTheDocument();
    });

    it('explains a failure in plain words with its reference, and tries again on request', async () => {
      let attempts = 0;
      installFakeApi({
        'GET /auth/me': () => jsonResponse(200, owner),
        [`GET /stations/${stationId}/overview`]: () => jsonResponse(200, overviewFor([])),
        [`GET /stations/${stationId}/clients`]: () => jsonResponse(200, []),
        [`GET /stations/${stationId}/ads`]: () => {
          attempts += 1;
          return attempts === 1
            ? errorResponse(500, 'INTERNAL', 'Something went wrong on our side.', 'feedface')
            : jsonResponse(200, { ads: [adSummary({ title: 'Back again' })], nextCursor: null });
        },
      });
      renderPortalAt(adsPath);

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent("We couldn't load your ads");
      expect(alert).toHaveTextContent('Reference: feedface');
      expect(document.body.textContent).not.toMatch(INTERNAL_DETAIL_PATTERN);
      await person.click(screen.getByRole('button', { name: 'Try again' }));
      expect(await screen.findByText('Back again')).toBeInTheDocument();
    });
  });

  describe('tabs, search, client and sort live in the address', () => {
    it('shows every tab in order, marks the current one, and counts what needs attention', async () => {
      const ads = [adSummary({ attentionReasons: ['upload_refused'] }), adSummary({ attentionReasons: ['ending_soon'] }), adSummary({ attentionReasons: ['start_date_passed'] })];
      installAds([{ ads, nextCursor: null }]);
      renderPortalAt(`${adsPath}?view=scheduled`);

      const tabs = await screen.findByRole('navigation', { name: 'Ad status' });
      await waitFor(() => expect(within(tabs).getByText(/3 need attention/)).toBeInTheDocument());
      expect(within(tabs).getAllByRole('link').map((link) => link.textContent?.replace(/\d need attention, \d/, ''))).toEqual([
        'All', 'Live now', 'Scheduled', 'Drafts', 'Needs attention', 'Ended',
      ]);
      expect(within(tabs).getByRole('link', { name: 'Scheduled' })).toHaveAttribute('aria-current', 'page');
      expect(within(tabs).getByRole('link', { name: 'All' })).not.toHaveAttribute('aria-current');
    });

    it('choosing a tab changes the address and asks the API for that tab', async () => {
      const queries: string[] = [];
      installAds([{ ads: [adSummary()], nextCursor: null }], { onList: (searchParams) => queries.push(searchParams.get('view') as string) });
      const { router } = renderPortalAt(adsPath);
      await screen.findByRole('navigation', { name: 'Ad status' });

      await person.click(screen.getByRole('link', { name: 'Live now' }));
      await waitFor(() => expect(router.state.location.search).toBe('?view=live'));
      await waitFor(() => expect(queries).toContain('live'));
    });

    it('choosing a client and a sort puts them in the address and the request', async () => {
      const requests: URLSearchParams[] = [];
      installAds([{ ads: [adSummary()], nextCursor: null }], { onList: (searchParams) => requests.push(searchParams) });
      const { router } = renderPortalAt(adsPath);
      await screen.findByRole('option', { name: 'Brand B' });

      await person.selectOptions(screen.getByRole('combobox', { name: 'Client' }), brandB.id);
      await person.selectOptions(screen.getByRole('combobox', { name: 'Sort by' }), 'A to Z');
      await waitFor(() => expect(router.state.location.search).toBe(`?client=${brandB.id}&sort=title`));
      await waitFor(() => expect(requests.at(-1)?.get('clientId')).toBe(brandB.id));
      expect(requests.at(-1)?.get('sort')).toBe('title');
    });

    it('typing in the search box waits for a pause, then searches', async () => {
      const requests: URLSearchParams[] = [];
      installAds([{ ads: [adSummary()], nextCursor: null }], { onList: (searchParams) => requests.push(searchParams) });
      const { router } = renderPortalAt(adsPath);
      const searchBox = await screen.findByRole('searchbox', { name: 'Search title or client' });

      await person.type(searchBox, 'summer');
      expect(router.state.location.search).toBe('');
      await waitFor(() => expect(router.state.location.search).toBe('?q=summer'), { timeout: 2000 });
      await waitFor(() => expect(requests.at(-1)?.get('search')).toBe('summer'));
      // Typing replaced the address instead of adding one step per letter.
      expect(router.state.historyAction).toBe('REPLACE');
    });

    it('starts from the address it was opened at, and ignores parts it does not recognise', async () => {
      const requests: URLSearchParams[] = [];
      installAds([{ ads: [adSummary()], nextCursor: null }], { onList: (searchParams) => requests.push(searchParams) });
      renderPortalAt(`${adsPath}?view=bogus&client=not-a-uuid&sort=loudest&q=lemon`);
      await screen.findByRole('navigation', { name: 'Ad status' });
      await waitFor(() => expect(requests.length).toBeGreaterThan(0));
      expect(Object.fromEntries(requests[0] as URLSearchParams)).toEqual({ view: 'all', sort: 'updated', search: 'lemon' });
      expect(screen.getByRole('searchbox')).toHaveValue('lemon');
    });

    it('offers to clear a search that found nothing', async () => {
      installAds([{ ads: [], nextCursor: null }]);
      const { router } = renderPortalAt(`${adsPath}?q=zzz`);
      expect(await screen.findByRole('heading', { name: 'No ads match' })).toBeInTheDocument();
      expect(screen.getByText(/matches “zzz”/)).toBeInTheDocument();
      await person.click(screen.getByRole('button', { name: 'Clear search and client' }));
      await waitFor(() => expect(router.state.location.search).toBe(''));
      await waitFor(() => expect(screen.getByRole('searchbox')).toHaveValue(''));
    });
  });

  describe('more ads', () => {
    it('shows 20 more when there are more, adds them to the list, and then stops offering', async () => {
      setWideScreen(false);
      const requests: URLSearchParams[] = [];
      const firstPage = Array.from({ length: 20 }, (_unused, index) => adSummary({ title: `First ${index}` }));
      const secondPage = [adSummary({ title: 'Second 0' }), adSummary({ title: 'Second 1' })];
      installAds(
        [
          { ads: firstPage, nextCursor: 'cursor-for-page-two' },
          { ads: secondPage, nextCursor: null },
        ],
        { onList: (searchParams) => requests.push(searchParams) },
      );
      renderPortalAt(adsPath);

      expect(await screen.findByText('Showing 20 ads')).toBeInTheDocument();
      await person.click(screen.getByRole('button', { name: 'Show 20 more' }));
      expect(await screen.findByText('Showing 22 ads')).toBeInTheDocument();
      expect(screen.getByText('First 0')).toBeInTheDocument();
      expect(screen.getByText('Second 1')).toBeInTheDocument();
      expect(requests.at(-1)?.get('cursor')).toBe('cursor-for-page-two');
      expect(screen.queryByRole('button', { name: 'Show 20 more' })).not.toBeInTheDocument();
    });
  });

  describe('playing an ad', () => {
    it('asks for the audio only when Play is pressed, and plays it', async () => {
      setWideScreen(false);
      const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
      const ad = adSummary({ title: 'Summer service offer' });
      const playbackPath = `/stations/${stationId}/ads/${ad.id}/playback-url`;
      installFakeApi({
        'GET /auth/me': () => jsonResponse(200, owner),
        [`GET /stations/${stationId}/overview`]: () => jsonResponse(200, overviewFor([ad])),
        [`GET /stations/${stationId}/clients`]: () => jsonResponse(200, []),
        [`GET /stations/${stationId}/ads`]: () => jsonResponse(200, { ads: [ad], nextCursor: null }),
        [`GET ${playbackPath}`]: () => jsonResponse(200, { url: 'http://127.0.0.1:39000/audio.wav', expiresAt: '2026-10-06T12:10:00Z' }),
      });
      const calls = (globalThis.fetch as unknown as { mock: { calls: Array<[string]> } }).mock.calls;
      renderPortalAt(adsPath);

      const playButton = await screen.findByRole('button', { name: 'Play Summer service offer' });
      expect(calls.some(([url]) => url.includes('playback-url'))).toBe(false);

      await person.click(playButton);
      await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
      expect(calls.filter(([url]) => url.includes('playback-url'))).toHaveLength(1);
      expect(await screen.findByRole('button', { name: 'Pause Summer service offer' })).toBeInTheDocument();
    });
  });
});
