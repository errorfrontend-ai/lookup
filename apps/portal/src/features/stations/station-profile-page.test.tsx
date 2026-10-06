import type { StationProfile } from '@lookup/contracts';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../app/portal-api';
import { errorResponse, installFakeApi, jsonResponse, signedInUserWith } from '../../test/fake-api';
import { renderPortalAt } from '../../test/render-portal';

const person = userEvent.setup({ delay: null });

function profileFor(station: ReturnType<typeof signedInUserWith>['stations'][number], overrides: Partial<StationProfile> = {}): StationProfile {
  return {
    id: station.id,
    name: station.name,
    frequencyLabel: station.frequencyLabel,
    province: 'Lusaka',
    city: 'Lusaka',
    timeZone: 'Africa/Lusaka',
    status: station.status,
    isListedInApp: true,
    yourRole: station.role,
    ...overrides,
  };
}

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
});

describe('Station profile', () => {
  it('shows the station\'s details in plain words, and says which changes Look Up checks', async () => {
    const user = signedInUserWith([{ name: 'Radio Phoenix', frequencyLabel: '89.5 FM', role: 'MANAGER' }]);
    const station = user.stations[0] as (typeof user.stations)[number];
    installFakeApi({
      'GET /auth/me': () => jsonResponse(200, user),
      [`GET /stations/${station.id}`]: () => jsonResponse(200, profileFor(station, { province: 'Copperbelt', city: 'Kitwe' })),
    });
    renderPortalAt(`/stations/${station.id}/profile`);

    const details = await screen.findByRole('region', { name: 'Station details' });
    expect(within(details).getByText('Radio Phoenix')).toBeInTheDocument();
    expect(within(details).getByText('89.5 FM')).toBeInTheDocument();
    expect(within(details).getByText('Copperbelt')).toBeInTheDocument();
    expect(within(details).getByText('Kitwe')).toBeInTheDocument();
    expect(within(details).getByText('Africa/Lusaka')).toBeInTheDocument();
    expect(within(details).getByText('Approved')).toBeInTheDocument();
    expect(within(details).getByText('Manager')).toBeInTheDocument();
    expect(screen.getByText(/checked by Look Up before they go live/)).toBeInTheDocument();
  });

  it('says "Not set" for a place that has not been filled in', async () => {
    const user = signedInUserWith([{}]);
    const station = user.stations[0] as (typeof user.stations)[number];
    installFakeApi({
      'GET /auth/me': () => jsonResponse(200, user),
      [`GET /stations/${station.id}`]: () => jsonResponse(200, profileFor(station, { province: null, city: null })),
    });
    renderPortalAt(`/stations/${station.id}/profile`);
    const details = await screen.findByRole('region', { name: 'Station details' });
    expect(within(details).getAllByText('Not set')).toHaveLength(2);
  });

  it('works while the station is under review, and explains what that means', async () => {
    const user = signedInUserWith([{ status: 'PENDING_REVIEW' }]);
    const station = user.stations[0] as (typeof user.stations)[number];
    installFakeApi({
      'GET /auth/me': () => jsonResponse(200, user),
      [`GET /stations/${station.id}`]: () => jsonResponse(200, profileFor(station)),
    });
    renderPortalAt(`/stations/${station.id}/profile`);
    const details = await screen.findByRole('region', { name: 'Station details' });
    expect(within(details).getByText('Under review')).toBeInTheDocument();
    expect(within(details).getByText(/checking this station's licence/)).toBeInTheDocument();
  });

  it('explains a failure and tries again on request', async () => {
    const user = signedInUserWith([{}]);
    const station = user.stations[0] as (typeof user.stations)[number];
    let attempts = 0;
    installFakeApi({
      'GET /auth/me': () => jsonResponse(200, user),
      [`GET /stations/${station.id}`]: () => {
        attempts += 1;
        return attempts === 1 ? errorResponse(503, 'SERVICE_UNAVAILABLE', 'Look Up is busy. Please try again.', 'cafe1234') : jsonResponse(200, profileFor(station));
      },
    });
    renderPortalAt(`/stations/${station.id}/profile`);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("We couldn't load your station's details");
    expect(alert).toHaveTextContent('Reference: cafe1234');
    await person.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: 'Station details' })).toBeInTheDocument();
  });
});
