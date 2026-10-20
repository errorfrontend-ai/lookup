import type { ListenerMix } from '@lookup/contracts';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../app/portal-api';
import { adDetail, listenerFigures, listenerMix, listenerMixWithGroups, overviewFor } from '../../test/ad-fixtures';
import { findAccessibilityProblems } from '../../test/accessibility';
import { errorResponse, INTERNAL_DETAIL_PATTERN, installFakeApi, jsonResponse, signedInUserWith } from '../../test/fake-api';
import { renderPortalAt } from '../../test/render-portal';

const person = userEvent.setup({ delay: null });
const owner = signedInUserWith([{ role: 'OWNER', name: 'Radio Phoenix', frequencyLabel: '89.5 FM' }]);
const stationId = owner.stations[0]?.id as string;
const overviewPath = `/stations/${stationId}/overview`;
const ad = adDetail({ title: 'Summer service offer' });

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
});

/** The Overview page, with who is listening answered by [mix] (given the range asked for). */
function installOverview(mix: (range: string) => Response | Promise<Response>) {
  return installFakeApi({
    'GET /auth/me': () => jsonResponse(200, owner),
    [`GET /stations/${stationId}/overview`]: () => jsonResponse(200, overviewFor([])),
    [`GET /stations/${stationId}/clients`]: () => jsonResponse(200, []),
    [`GET /stations/${stationId}/listener-figures`]: () => jsonResponse(200, listenerFigures({ recognitions: 40 })),
    [`GET /stations/${stationId}/listener-mix`]: (_body, { searchParams }) => mix(searchParams.get('range') ?? ''),
  });
}

/** The section, found by its heading. */
async function whoIsListening() {
  return screen.findByRole('region', { name: 'Who is listening' });
}

/** Each listener tile as [title, value, note]. */
function tiles(section: HTMLElement) {
  return [...within(section).getByLabelText('Listeners').querySelectorAll(':scope > div')].map((tile) => [...tile.children].map((part) => part.textContent));
}

/** The rows of one breakdown's bars, as "label number". */
function barRows(section: HTMLElement, name: string) {
  return within(within(section).getByRole('list', { name })).getAllByRole('listitem').map((row) => row.textContent);
}

describe('Who is listening (LA-STATS-07)', () => {
  it('shows the listeners, those with an account and those not known yet, then both breakdowns as bars in their order, with "Other groups" last', async () => {
    installOverview(() => jsonResponse(200, listenerMixWithGroups()));
    renderPortalAt(overviewPath);
    const section = await whoIsListening();
    await within(section).findByRole('list', { name: 'By gender' });

    expect(tiles(section)).toEqual([
      ['Listeners', '30', 'Different people who identified your ads'],
      ['With an account', '25', 'They told us their gender and age'],
      ["People we don't know yet", '5', 'No account yet, or signed out'],
    ]);
    expect(barRows(section, 'By gender')).toEqual(['Women14', 'Preferred not to say0', 'Other groups11']);
    expect(barRows(section, 'By age')).toEqual(['Under 180', '35–4412', '45–540', '55 and over0', 'Other groups13']);
    expect(within(section).getByText(/you only ever see groups: a group with fewer than 10 people is counted under "Other groups"/)).toBeInTheDocument();
  });

  it('draws each bar against the largest group of its breakdown, and none for a zero', async () => {
    installOverview(() => jsonResponse(200, listenerMixWithGroups()));
    renderPortalAt(overviewPath);
    const section = await whoIsListening();
    const genders = await within(section).findByRole('list', { name: 'By gender' });
    const widths = [...genders.querySelectorAll('[aria-hidden="true"] > span')].map((bar) => (bar as HTMLElement).style.width);
    expect(widths).toEqual(['100%', '0%', `${(11 / 14) * 100}%`]);
  });

  it('switches both breakdowns to tables and back, with one labelled switch', async () => {
    installOverview(() => jsonResponse(200, listenerMixWithGroups()));
    renderPortalAt(overviewPath);
    const section = await whoIsListening();
    const views = await within(section).findByRole('group', { name: 'Show who is listening as' });
    expect(within(views).getByRole('button', { name: 'Chart' })).toHaveAttribute('aria-pressed', 'true');

    await person.click(within(views).getByRole('button', { name: 'Table' }));
    expect(within(views).getByRole('button', { name: 'Table' })).toHaveAttribute('aria-pressed', 'true');
    const genders = within(section).getByRole('table', { name: 'Listeners by gender' });
    expect(within(genders).getAllByRole('row').map((row) => row.textContent)).toEqual(['GroupListeners', 'Women14', 'Preferred not to say0', 'Other groups11']);
    expect(within(section).getByRole('table', { name: 'Listeners by age' })).toBeInTheDocument();
    expect(within(section).queryByRole('list', { name: 'By gender' })).not.toBeInTheDocument();

    await person.click(within(views).getByRole('button', { name: 'Chart' }));
    expect(within(section).getByRole('list', { name: 'By gender' })).toBeInTheDocument();
  });

  it('says there are not enough listeners yet to show groups when there are fewer than 10 with an account, and still gives the counts', async () => {
    installOverview(() => jsonResponse(200, listenerMix({ listeners: 12, knownListeners: 9, notKnownYetListeners: 3 })));
    renderPortalAt(overviewPath);
    const section = await whoIsListening();
    expect(await within(section).findByText('Not enough listeners yet to show groups. Groups appear once at least 10 listeners with an account have identified your ads.')).toBeInTheDocument();
    expect(tiles(section).map((tile) => tile[1])).toEqual(['12', '9', '3']);
    expect(within(section).queryByRole('list', { name: 'By gender' })).not.toBeInTheDocument();
    expect(within(section).queryByRole('group', { name: 'Show who is listening as' })).not.toBeInTheDocument();
  });

  it('says plainly when nobody has identified the ads in these dates', async () => {
    installOverview(() => jsonResponse(200, listenerMix()));
    renderPortalAt(overviewPath);
    const section = await whoIsListening();
    expect(await within(section).findByText('No listeners in these dates yet. They appear here once people identify your ads in the Look Up app.')).toBeInTheDocument();
  });

  it('shows a placeholder while it loads, then the numbers', async () => {
    let answer: (response: Response) => void = () => undefined;
    installOverview(() => new Promise<Response>((resolve) => (answer = resolve)));
    renderPortalAt(overviewPath);
    const section = await whoIsListening();
    expect(section.querySelector('.animate-pulse')).not.toBeNull();
    expect(within(section).queryByLabelText('Listeners')).not.toBeInTheDocument();
    answer(jsonResponse(200, listenerMixWithGroups()));
    expect(await within(section).findByRole('list', { name: 'By gender' })).toBeInTheDocument();
    expect(section.querySelector('.animate-pulse')).toBeNull();
  });

  it('explains a failure in plain words with its reference, and tries again on request', async () => {
    let attempts = 0;
    installOverview(() => {
      attempts += 1;
      return attempts === 1 ? errorResponse(500, 'INTERNAL', 'Something went wrong on our side.', 'm1xfa1ed') : jsonResponse(200, listenerMixWithGroups());
    });
    renderPortalAt(overviewPath);
    const section = await whoIsListening();
    const alert = await within(section).findByRole('alert');
    expect(alert).toHaveTextContent("We couldn't load who is listening");
    expect(alert).toHaveTextContent('Reference: m1xfa1ed');
    expect(document.body.textContent).not.toMatch(INTERNAL_DETAIL_PATTERN);
    await person.click(within(section).getByRole('button', { name: 'Try again' }));
    expect(await within(section).findByRole('list', { name: 'By gender' })).toBeInTheDocument();
  });

  it('on Overview it follows the page\'s dates: choosing "Today" asks for today, and says so', async () => {
    const asked: string[] = [];
    installOverview((range) => {
      asked.push(range);
      return jsonResponse(200, listenerMixWithGroups({ range: range as ListenerMix['range'] }));
    });
    renderPortalAt(overviewPath);
    const section = await whoIsListening();
    await within(section).findByText(/^Last 7 days ·/);
    await person.selectOptions(screen.getByLabelText('Date range'), 'today');
    expect(await within(section).findByText(/^Today ·/)).toBeInTheDocument();
    expect(asked).toEqual(['last7Days', 'today']);
    expect(within(section).queryByLabelText('Dates for who is listening')).not.toBeInTheDocument();
  });

  it('while new dates load, the numbers on screen keep the dates they are for, then change together', async () => {
    let answerToday: (response: Response) => void = () => undefined;
    installOverview((range) =>
      range === 'today'
        ? new Promise<Response>((resolve) => (answerToday = resolve))
        : jsonResponse(200, listenerMixWithGroups({ range: 'last7Days' })),
    );
    renderPortalAt(overviewPath);
    const section = await whoIsListening();
    await within(section).findByText(/^Last 7 days ·/);
    await person.selectOptions(screen.getByLabelText('Date range'), 'today');
    expect(within(section).getByText(/^Last 7 days ·/)).toBeInTheDocument();
    expect(tiles(section)[0]?.[1]).toBe('30');
    answerToday(jsonResponse(200, listenerMix({ range: 'today', listeners: 2, knownListeners: 1, notKnownYetListeners: 1 })));
    expect(await within(section).findByText(/^Today ·/)).toBeInTheDocument();
    expect(tiles(section)[0]?.[1]).toBe('2');
  });

  it('puts the numbers and the two breakdowns side by side on a wide screen and one under the other on a phone', async () => {
    installOverview(() => jsonResponse(200, listenerMixWithGroups()));
    renderPortalAt(overviewPath);
    const section = await whoIsListening();
    const genders = await within(section).findByRole('region', { name: 'By gender' });
    expect(genders.parentElement).toHaveClass('grid', 'grid-cols-1', 'md:grid-cols-2');
    // The three numbers too: the portal's "sm" is 375 px, a phone, so their columns start at "md" (768 px).
    const numbers = within(section).getByLabelText('Listeners');
    expect(numbers).toHaveClass('grid-cols-1', 'md:grid-cols-3');
    expect(numbers.className).not.toMatch(/sm:grid-cols/);
  });

  it('has nothing axe can find wrong, as bars and as tables', async () => {
    installOverview(() => jsonResponse(200, listenerMixWithGroups()));
    renderPortalAt(overviewPath);
    const section = await whoIsListening();
    await within(section).findByRole('list', { name: 'By gender' });
    expect(await findAccessibilityProblems(section)).toEqual([]);
    await person.click(within(section).getByRole('button', { name: 'Table' }));
    expect(await findAccessibilityProblems(section)).toEqual([]);
  });

  describe("on an ad's Overview tab", () => {
    function installAdPage(mix: (range: string) => Response) {
      return installFakeApi({
        'GET /auth/me': () => jsonResponse(200, owner),
        [`GET /stations/${stationId}/overview`]: () => jsonResponse(200, overviewFor([])),
        [`GET /stations/${stationId}/ads/${ad.id}`]: () => jsonResponse(200, ad),
        [`GET /stations/${stationId}/ads/${ad.id}/history`]: () => jsonResponse(200, { events: [], nextCursor: null }),
        [`GET /stations/${stationId}/ads/${ad.id}/listener-mix`]: (_body, { searchParams }) => mix(searchParams.get('range') ?? ''),
      });
    }

    it("asks for that ad's listeners over the last 7 days, speaks of this ad, and has its own date choice", async () => {
      const asked: string[] = [];
      installAdPage((range) => {
        asked.push(range);
        return jsonResponse(200, listenerMixWithGroups({ range: range as ListenerMix['range'] }));
      });
      renderPortalAt(`/stations/${stationId}/ads/${ad.id}`);
      const section = await whoIsListening();
      expect(await within(section).findByText('Different people who identified this ad')).toBeInTheDocument();
      await person.selectOptions(within(section).getByLabelText('Dates for who is listening'), 'last30Days');
      expect(await within(section).findByText(/^Last 30 days ·/)).toBeInTheDocument();
      expect(asked).toEqual(['last7Days', 'last30Days']);
    });

    it('says when this ad has too few listeners with an account for groups', async () => {
      installAdPage(() => jsonResponse(200, listenerMix({ listeners: 4, knownListeners: 3, notKnownYetListeners: 1 })));
      renderPortalAt(`/stations/${stationId}/ads/${ad.id}`);
      const section = await whoIsListening();
      expect(await within(section).findByText(/have identified this ad\.$/)).toBeInTheDocument();
    });
  });
});
