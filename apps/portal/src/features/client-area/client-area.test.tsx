import type { ClientAdDetail, ClientAdFigures, ClientHome, ClientStationSection, ListenerMix, SignedInPortalUser } from '@lookup/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../app/portal-api';
import { stationToday } from '../../plain-words/client-words';
import { findAccessibilityProblems } from '../../test/accessibility';
import { errorResponse, INTERNAL_DETAIL_PATTERN, installFakeApi, jsonResponse, signedInUserWith } from '../../test/fake-api';
import { actionCardFixture } from '../../test/ad-fixtures';
import { renderPortalAt } from '../../test/render-portal';
import { clientAreaTitle } from './client-shell';

const person = userEvent.setup({ delay: null });
const STATION_A = '0190f1a2-0000-7000-8000-00000000c0a1';
const STATION_B = '0190f1a2-0000-7000-8000-00000000c0b2';
const BRAND_A_AT_A = '0190f1a2-0000-7000-8000-00000000c1a1';
const BRAND_A_AT_B = '0190f1a2-0000-7000-8000-00000000c1b2';
const LIVE_AD = '0190f1a2-0000-7000-8000-00000000ad01';
const ENDED_AD = '0190f1a2-0000-7000-8000-00000000ad02';
const AD_AT_B = '0190f1a2-0000-7000-8000-00000000ad03';
const today = stationToday('Africa/Lusaka');
const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

const client: SignedInPortalUser = {
  ...signedInUserWith([]),
  user: { id: '0190f1a2-0000-7000-8000-0000000000c9', fullName: 'Chipo Banda', email: 'chipo@brand-a.example', platformRole: null },
  clientAccesses: [
    { stationId: STATION_A, stationName: 'Station A', frequencyLabel: '98.1 FM', clientId: BRAND_A_AT_A, clientName: 'Brand A' },
    { stationId: STATION_B, stationName: 'Station B', frequencyLabel: '89.5 FM', clientId: BRAND_A_AT_B, clientName: 'Brand A' },
  ],
};

const slot = (localDate: string, start: string, end: string) => ({ startsAt: `${localDate}T05:00:00.000Z`, endsAt: `${localDate}T07:00:00.000Z`, localDate, localStartTime: start, localEndTime: end });

const sectionA: ClientStationSection = {
  stationId: STATION_A,
  stationName: 'Station A',
  frequencyLabel: '98.1 FM',
  timeZone: 'Africa/Lusaka',
  contact: { name: 'Mwila Banda', phoneNumberE164: '+260971234567' },
  clients: [{ id: BRAND_A_AT_A, name: 'Brand A' }],
  nextOnAir: { ...slot(today, '07:00', '09:00'), adId: LIVE_AD, adTitle: 'Summer service offer' },
  lastSevenDays: { heard: 128, calls: 12, whatsApp: 7, directions: 5, website: 3 },
  ads: [
    {
      id: LIVE_AD, title: 'Summer service offer', clientId: BRAND_A_AT_A, clientName: 'Brand A', status: 'LIVE_NOW', startsOn: '2026-10-01', endsOn: '2099-10-31',
      timeWindows: [{ daysOfWeek: [1, 2, 3, 4, 5], localStartTime: '07:00', localEndTime: '09:00' }], heardLastSevenDays: 120, nextOnAir: slot(today, '07:00', '09:00'),
    },
    {
      id: ENDED_AD, title: 'Winter offer', clientId: BRAND_A_AT_A, clientName: 'Brand A', status: 'ENDED', startsOn: '2026-08-01', endsOn: '2026-09-30',
      timeWindows: [{ daysOfWeek: [6, 7], localStartTime: '10:00', localEndTime: '12:00' }], heardLastSevenDays: 8, nextOnAir: null,
    },
  ],
};
const sectionB: ClientStationSection = {
  stationId: STATION_B,
  stationName: 'Station B',
  frequencyLabel: '89.5 FM',
  timeZone: 'Africa/Lusaka',
  contact: { name: null, phoneNumberE164: null },
  clients: [{ id: BRAND_A_AT_B, name: 'Brand A' }],
  nextOnAir: null,
  lastSevenDays: { heard: 9, calls: 1, whatsApp: 0, directions: 0, website: 0 },
  ads: [
    {
      id: AD_AT_B, title: 'Summer offer on B', clientId: BRAND_A_AT_B, clientName: 'Brand A', status: 'PAUSED', startsOn: '2026-10-01', endsOn: '2099-10-31',
      timeWindows: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], localStartTime: '22:00', localEndTime: '01:00' }], heardLastSevenDays: 9, nextOnAir: null,
    },
  ],
};
const home: ClientHome = { stations: [sectionA, sectionB] };

const adDetail: ClientAdDetail = {
  ...(sectionA.ads[0] as ClientStationSection['ads'][number]),
  station: { id: STATION_A, name: 'Station A', frequencyLabel: '98.1 FM', timeZone: 'Africa/Lusaka', contact: sectionA.contact },
  actionCard: actionCardFixture(),
  nextTimesOnAir: [slot(today, '07:00', '09:00'), slot(tomorrow, '07:00', '09:00'), slot('2099-01-05', '07:00', '09:00'), slot('2099-01-06', '07:00', '09:00'), slot('2099-01-07', '07:00', '09:00')],
};
const figures = (range: ClientAdFigures['range']): ClientAdFigures => ({ range, firstDay: today, lastDay: today, heard: range === 'today' ? 14 : 120, calls: 12, whatsApp: 7, directions: 5, website: 0 });
const mix: ListenerMix = {
  range: 'last30Days', firstDay: today, lastDay: today, listeners: 30, knownListeners: 25, notKnownYetListeners: 5,
  genders: [{ group: 'FEMALE', listeners: 15 }, { group: 'MALE', listeners: 10 }],
  ageBands: [{ group: 'AGE_25_TO_34', listeners: 15 }, { group: 'OTHER_GROUPS', listeners: 10 }],
};
const adPath = `/client/stations/${STATION_A}/ads/${LIVE_AD}`;

function clientApi(extra: Parameters<typeof installFakeApi>[0] = {}) {
  return installFakeApi({
    'GET /auth/me': () => jsonResponse(200, client),
    'GET /client/home': () => jsonResponse(200, home),
    [`GET ${adPath}`]: () => jsonResponse(200, adDetail),
    [`GET ${adPath}/figures`]: (_body, request) => jsonResponse(200, figures((request.searchParams.get('range') ?? 'last7Days') as ClientAdFigures['range'])),
    [`GET ${adPath}/listener-mix`]: () => jsonResponse(200, mix),
    ...extra,
  });
}

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
});

describe('the client area', () => {
  it('P5C-DASHBOARD-01: a person who follows a client and belongs to no station lands on /client after signing in', async () => {
    clientApi();
    const { router } = renderPortalAt('/');
    await waitFor(() => expect(router.state.location.pathname).toBe('/client'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Your adverts' })).toBeInTheDocument();
  });

  it('P5C-DASHBOARD-05: the header says Look Up and whose adverts these are, with Home, Account and Sign out', async () => {
    clientApi();
    renderPortalAt('/client');
    const banner = await screen.findByRole('banner');
    expect(within(banner).getByText('Look Up')).toBeInTheDocument();
    expect(within(banner).getByText('Brand A')).toBeInTheDocument();
    const menu = within(banner).getByRole('navigation', { name: 'Client menu' });
    expect(within(menu).getAllByRole('link').map((link) => link.textContent)).toEqual(['Home', 'Account']);
    expect(within(menu).getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    // On a phone the same menu opens behind a Menu button.
    await person.click(within(banner).getByRole('button', { name: 'Menu' }));
    expect(within(banner).getByRole('navigation', { name: 'Menu' })).toBeInTheDocument();
    // Several clients: the person's own name.
    expect(clientAreaTitle({ ...client, clientAccesses: [...client.clientAccesses, { stationId: STATION_B, stationName: 'Station B', frequencyLabel: null, clientId: BRAND_A_AT_A, clientName: 'Brand C' }] })).toBe('Chipo Banda');
  });

  it('P5C-DASHBOARD-02, P5C-TESTS-01: two stations are two sections, each with its own next slot, figures and adverts, never added together', async () => {
    clientApi();
    renderPortalAt('/client');
    const stationA = await screen.findByRole('region', { name: 'Station A · 98.1 FM' });
    const stationB = screen.getByRole('region', { name: 'Station B · 89.5 FM' });
    expect(within(stationA).getByText('Today 07:00–09:00')).toBeInTheDocument();
    expect(within(stationA).getByRole('link', { name: 'Summer service offer' })).toHaveAttribute('href', adPath);
    expect(within(stationB).getByText('Nothing scheduled in the next 14 days.')).toBeInTheDocument();
    // P5C-DASHBOARD-07: each station's own last 7 days.
    const figuresA = within(stationA).getByLabelText('Last 7 days on Station A · 98.1 FM');
    expect(within(figuresA).getByText('128')).toBeInTheDocument();
    expect(within(figuresA).getByText('12')).toBeInTheDocument();
    const figuresB = within(stationB).getByLabelText('Last 7 days on Station B · 89.5 FM');
    expect(within(figuresB).getByText('9')).toBeInTheDocument();
    // Nothing anywhere adds the two stations: 128 + 9 heard never appears.
    expect(screen.queryByText('137')).not.toBeInTheDocument();
    expect(within(stationA).queryByText('Summer offer on B')).not.toBeInTheDocument();
    expect(await findAccessibilityProblems()).toEqual([]);
  });

  it('P5C-DASHBOARD-08: each advert shows its title, status, schedule, dates and how often it was heard', async () => {
    clientApi();
    renderPortalAt('/client');
    const stationA = await screen.findByRole('region', { name: 'Station A · 98.1 FM' });
    const ads = within(stationA).getByRole('heading', { name: 'Your ads on Station A' }).parentElement as HTMLElement;
    const live = within(ads).getByRole('link', { name: /Summer service offer/ });
    expect(within(live).getByText('On air now')).toBeInTheDocument();
    expect(within(live).getByText('Mon–Fri · 07:00–09:00 · Until 31 Oct')).toBeInTheDocument();
    expect(within(live).getByText('Heard 120 times in the last 7 days')).toBeInTheDocument();
    const ended = within(ads).getByRole('link', { name: /Winter offer/ });
    expect(within(ended).getByText('Ended')).toBeInTheDocument();
    expect(within(ended).getByText('Sat, Sun · 10:00–12:00 · Ended 30 Sep')).toBeInTheDocument();
    const stationB = screen.getByRole('region', { name: 'Station B · 89.5 FM' });
    expect(within(stationB).getByText('Paused')).toBeInTheDocument();
  });

  it('P5C-DASHBOARD-06: each station says it is view only and who to ask, the number a tap away', async () => {
    clientApi();
    renderPortalAt('/client');
    const stationA = await screen.findByRole('region', { name: 'Station A · 98.1 FM' });
    const note = within(stationA).getByRole('note');
    expect(note).toHaveTextContent('View only. To change an ad or its buttons, contact Mwila Banda at Station A on +260971234567.');
    expect(within(note).getByRole('link', { name: '+260971234567' })).toHaveAttribute('href', 'tel:+260971234567');
    expect(within(screen.getByRole('region', { name: 'Station B · 89.5 FM' })).getByRole('note')).toHaveTextContent('View only. To change an ad or its buttons, contact Station B.');
  });

  it('P5C-EXPORT-01: Download as spreadsheet saves the station’s file under the name the API gave it', async () => {
    // jsdom makes no object addresses: the test gives one, and puts the browser's own back afterwards.
    const objectAddresses = { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:look-up-spreadsheet'), revokeObjectURL: vi.fn() });
    const clicked: Array<{ href: string; download: string }> = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.getAttribute('href') ?? '', download: this.download });
    });
    clientApi({
      [`GET /client/stations/${STATION_A}/export.csv`]: () =>
        new Response('\uFEFF"Day","Advert"\r\n', { status: 200, headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="look-up-station-a-2026-10-24.csv"' } }),
    });
    try {
      renderPortalAt('/client');
      const stationA = await screen.findByRole('region', { name: 'Station A · 98.1 FM' });
      await person.click(within(stationA).getByRole('button', { name: 'Download as spreadsheet (CSV) for Station A' }));
      await waitFor(() => expect(clicked).toEqual([{ href: 'blob:look-up-spreadsheet', download: 'look-up-station-a-2026-10-24.csv' }]));
    } finally {
      click.mockRestore();
      Object.assign(URL, objectAddresses);
    }
  });

  it('P5C-EXPORT-01: a spreadsheet that cannot be made says so in plain words, with the reference', async () => {
    clientApi({ [`GET /client/stations/${STATION_A}/export.csv`]: () => errorResponse(500, 'INTERNAL', 'Something went wrong on our side. Please try again.', 'ref-123') });
    renderPortalAt('/client');
    const stationA = await screen.findByRole('region', { name: 'Station A · 98.1 FM' });
    await person.click(within(stationA).getByRole('button', { name: /Download as spreadsheet/ }));
    expect(await within(stationA).findByText("We couldn't prepare the spreadsheet")).toBeInTheDocument();
    expect(stationA.textContent).not.toMatch(INTERNAL_DETAIL_PATTERN);
  });

  it('P5C-ONBOARDING-06: with no access left, the home says so and what to do', async () => {
    clientApi({ 'GET /client/home': () => jsonResponse(200, { stations: [] }) });
    renderPortalAt('/client');
    expect(await screen.findByRole('heading', { name: "You can't view any adverts right now" })).toBeInTheDocument();
    expect(screen.getByText(/Ask the station to invite you again/)).toBeInTheDocument();
    expect(await findAccessibilityProblems()).toEqual([]);
  });

  it('a home that cannot load says so, with a way to try again', async () => {
    let attempts = 0;
    clientApi({
      'GET /client/home': () => {
        attempts += 1;
        return attempts === 1 ? errorResponse(500, 'INTERNAL', 'Something went wrong on our side. Please try again.') : jsonResponse(200, home);
      },
    });
    renderPortalAt('/client');
    expect(await screen.findByText("We couldn't load your adverts")).toBeInTheDocument();
    await person.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: 'Station A · 98.1 FM' })).toBeInTheDocument();
  });
});

describe("a client's advert", () => {
  it('P5C-ADVERT-01: shows its dates, the week’s slots and the next 5 times on air in the station’s words', async () => {
    clientApi();
    renderPortalAt(adPath);
    expect(await screen.findByRole('heading', { level: 1, name: 'Summer service offer' })).toBeInTheDocument();
    const schedule = screen.getByRole('region', { name: 'When it airs' });
    expect(within(schedule).getByText('Mon–Fri · 07:00–09:00')).toBeInTheDocument();
    expect(within(schedule).getByText(/Until 31 Oct/)).toBeInTheDocument();
    expect(within(schedule).getByText("Times are Station A's own (Africa/Lusaka).")).toBeInTheDocument();
    const next = screen.getByRole('heading', { name: 'Next times on air' }).parentElement as HTMLElement;
    expect(within(next).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Today 07:00–09:00',
      'Tomorrow 07:00–09:00',
      'Mon 5 Jan 2099 07:00–09:00',
      'Tue 6 Jan 2099 07:00–09:00',
      'Wed 7 Jan 2099 07:00–09:00',
    ]);
  });

  it('P5C-DASHBOARD-09, P5C-ADVERT-02: what listeners did, for today, 7 or 30 days, as bars with the counts as text, or as a table', async () => {
    const api = clientApi();
    renderPortalAt(adPath);
    const section = await screen.findByRole('region', { name: 'What listeners did' });
    expect(await within(section).findByText('120')).toBeInTheDocument();
    const bars = within(section).getByRole('list', { name: 'Taps by button' });
    expect(within(bars).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Calls12', 'WhatsApp7', 'Directions5', 'Website0']);
    for (const bar of bars.querySelectorAll('[style]')) expect(bar.closest('[aria-hidden="true"]')).not.toBeNull();
    await person.click(within(section).getByRole('button', { name: 'Table' }));
    const table = within(section).getByRole('table', { name: 'Taps by button' });
    expect(within(table).getByRole('row', { name: 'Calls 12' })).toBeInTheDocument();
    await person.selectOptions(within(section).getByLabelText('Dates for what listeners did'), 'today');
    expect(await within(section).findByText('14')).toBeInTheDocument();
    expect(api.calls.some((call) => call.path === `${adPath}/figures?range=today`)).toBe(true);
    expect(await findAccessibilityProblems()).toEqual([]);
  });

  it('P5C-ADVERT-03: who is listening shows the groups the contract allows, never a person', async () => {
    clientApi();
    renderPortalAt(adPath);
    const section = await screen.findByRole('region', { name: 'Who is listening' });
    expect(await within(section).findByRole('list', { name: 'By gender' })).toHaveTextContent('Women15');
    expect(within(section).getByRole('list', { name: 'By age' })).toHaveTextContent('Other groups10');
  });

  it('P5C-ADVERT-04: the card listeners see and the note on who to ask for a change', async () => {
    clientApi();
    renderPortalAt(adPath);
    const card = await screen.findByRole('region', { name: 'What listeners see' });
    expect(within(card).getByText('Call Brand A')).toBeInTheDocument();
    expect(within(card).getByText('Get directions')).toBeInTheDocument();
    expect(within(card).getByText('Brand A · via Station A · 98.1 FM')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('View only. To change this ad or its buttons, contact Mwila Banda at Station A on +260971234567.');
  });

  it('P5C-DASHBOARD-04: no page of the client area offers a control that changes station data', async () => {
    clientApi();
    renderPortalAt('/client');
    await screen.findByRole('region', { name: 'Station A · 98.1 FM' });
    const forbidden = /edit|delete|remove|pause|publish|upload|archive|new ad|add/i;
    expect(screen.getAllByRole('button').map((button) => button.textContent).filter((name) => forbidden.test(name ?? ''))).toEqual([]);
    expect(screen.queryAllByRole('textbox')).toEqual([]);
    queryClient.clear();
    renderPortalAt(adPath);
    await screen.findByRole('region', { name: 'What listeners did' });
    expect(screen.getAllByRole('button').map((button) => button.textContent).filter((name) => forbidden.test(name ?? ''))).toEqual([]);
    expect(screen.queryAllByRole('textbox')).toEqual([]);
  });

  it('P5C-ACCESS-04: an advert the person may not view says it cannot be found, as for one that does not exist', async () => {
    clientApi({ [`GET ${adPath}`]: () => errorResponse(404, 'NOT_FOUND', 'We could not find that.') });
    renderPortalAt(adPath);
    expect(await screen.findByRole('heading', { name: "We couldn't find that advert" })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See all your adverts' })).toHaveAttribute('href', '/client');
    expect(await findAccessibilityProblems()).toEqual([]);
  });
});
