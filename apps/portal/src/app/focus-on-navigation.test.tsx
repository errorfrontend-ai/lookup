import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adSummary, overviewFor } from '../test/ad-fixtures';
import { installFakeApi, jsonResponse, signedInUserWith } from '../test/fake-api';
import { renderPortalAt } from '../test/render-portal';
import { queryClient } from './portal-api';

const person = userEvent.setup({ delay: null });
const owner = signedInUserWith([{ role: 'OWNER' }]);
const stationId = owner.stations[0]?.id as string;

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
});

function installStation() {
  installFakeApi({
    'GET /auth/me': () => jsonResponse(200, owner),
    [`GET /stations/${stationId}/overview`]: () => jsonResponse(200, overviewFor([adSummary()])),
    [`GET /stations/${stationId}/clients`]: () => jsonResponse(200, [{ id: '0190f1a2-0000-7000-8000-0000000000a1', name: 'Brand A', adCount: 1, liveNowAdCount: 1 }]),
    [`GET /stations/${stationId}/ads`]: () => jsonResponse(200, { ads: [adSummary()], nextCursor: null }),
  });
}

describe('where focus goes when the page changes', () => {
  it('stays where it is on first arrival, so nothing jumps', async () => {
    installStation();
    renderPortalAt(`/stations/${stationId}/overview`);
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).not.toHaveFocus();
  });

  it('moves to the new page\'s heading after following a link, so the page is announced', async () => {
    installStation();
    renderPortalAt(`/stations/${stationId}/overview`);
    await screen.findByRole('heading', { level: 1, name: 'Overview' });

    await person.click(screen.getAllByRole('link', { name: 'Ads' })[0] as HTMLElement);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Ads' })).toHaveFocus());
  });

  it('moves to the new step\'s heading in the new-ad wizard', async () => {
    installStation();
    renderPortalAt(`/stations/${stationId}/ads/new`);
    await person.click(await screen.findByRole('radio', { name: /Brand A/ }));
    await person.click(screen.getByRole('button', { name: 'Next: Audio' }));
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Upload the ad' })).toHaveFocus());

    await person.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Who is this ad for?' })).toHaveFocus());
  });
});
