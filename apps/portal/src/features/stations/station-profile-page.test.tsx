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

  describe('editing where the station is', () => {
    function installEditable(role: 'OWNER' | 'MANAGER' | 'ANALYST', options: { status?: 'ACTIVE' | 'PENDING_REVIEW'; onSave?: (body: unknown) => Response } = {}) {
      const user = signedInUserWith([{ role, status: options.status ?? 'ACTIVE' }]);
      const station = user.stations[0] as (typeof user.stations)[number];
      let saved: Partial<StationProfile> = {};
      const fakeApi = installFakeApi({
        'GET /auth/me': () => jsonResponse(200, user),
        [`GET /stations/${station.id}`]: () => jsonResponse(200, profileFor(station, { province: null, city: null, ...saved })),
        [`PUT /stations/${station.id}/profile`]: (body) => {
          if (options.onSave) return options.onSave(body);
          saved = body as Partial<StationProfile>;
          return jsonResponse(200, profileFor(station, saved));
        },
      });
      return { station, fakeApi };
    }

    it('lets an owner choose a province and type a city, saves them, confirms, and shows them', async () => {
      const { station, fakeApi } = installEditable('OWNER');
      renderPortalAt(`/stations/${station.id}/profile`);
      await person.click(await screen.findByRole('button', { name: 'Edit where you are' }));

      const province = screen.getByLabelText('Province');
      expect([...within(province).getAllByRole('option')].map((option) => option.textContent)).toEqual([
        'Not set', 'Central', 'Copperbelt', 'Eastern', 'Luapula', 'Lusaka', 'Muchinga', 'Northern', 'North-Western', 'Southern', 'Western',
      ]);
      await person.selectOptions(province, 'Copperbelt');
      await person.type(screen.getByLabelText('City or town'), '  Kitwe ');
      await person.click(screen.getByRole('button', { name: 'Save' }));

      expect(await screen.findByText('Station details saved')).toBeInTheDocument();
      const details = screen.getByRole('region', { name: 'Station details' });
      expect(await within(details).findByText('Copperbelt')).toBeInTheDocument();
      expect(within(details).getByText('Kitwe')).toBeInTheDocument();
      expect(screen.queryByLabelText('Province')).not.toBeInTheDocument();
      expect(fakeApi.calls.find((call) => call.method === 'PUT')?.body).toEqual({ province: 'Copperbelt', city: 'Kitwe' });
    });

    it('clears a province and a city that are no longer wanted', async () => {
      const { station, fakeApi } = installEditable('MANAGER');
      renderPortalAt(`/stations/${station.id}/profile`);
      await person.click(await screen.findByRole('button', { name: 'Edit where you are' }));
      await person.type(screen.getByLabelText('City or town'), 'Somewhere');
      await person.clear(screen.getByLabelText('City or town'));
      await person.click(screen.getByRole('button', { name: 'Save' }));
      await screen.findByText('Station details saved');
      expect(fakeApi.calls.find((call) => call.method === 'PUT')?.body).toEqual({ province: null, city: null });
    });

    it('leaves everything as it was when cancelled, and sends nothing', async () => {
      const { station, fakeApi } = installEditable('OWNER');
      renderPortalAt(`/stations/${station.id}/profile`);
      await person.click(await screen.findByRole('button', { name: 'Edit where you are' }));
      await person.type(screen.getByLabelText('City or town'), 'Ndola');
      await person.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByLabelText('City or town')).not.toBeInTheDocument();
      expect(screen.getAllByText('Not set')).toHaveLength(2);
      expect(fakeApi.calls.some((call) => call.method === 'PUT')).toBe(false);
    });

    it('offers analysts no way to edit', async () => {
      const { station } = installEditable('ANALYST');
      renderPortalAt(`/stations/${station.id}/profile`);
      await screen.findByRole('region', { name: 'Station details' });
      expect(screen.queryByRole('button', { name: 'Edit where you are' })).not.toBeInTheDocument();
    });

    it('works while the station is still under review', async () => {
      const { station } = installEditable('OWNER', { status: 'PENDING_REVIEW' });
      renderPortalAt(`/stations/${station.id}/profile`);
      expect(await screen.findByRole('button', { name: 'Edit where you are' })).toBeInTheDocument();
    });

    it('explains a refused city next to the box, and any other failure with its reference', async () => {
      let attempt = 0;
      const { station } = installEditable('OWNER', {
        onSave: () => {
          attempt += 1;
          return attempt === 1
            ? errorResponse(400, 'VALIDATION_FAILED', 'Some details are missing or not valid.', 'abc', [{ path: 'city', code: 'too_big' }])
            : errorResponse(503, 'SERVICE_UNAVAILABLE', 'Look Up is busy. Please try again.', 'cafe5678');
        },
      });
      renderPortalAt(`/stations/${station.id}/profile`);
      await person.click(await screen.findByRole('button', { name: 'Edit where you are' }));
      await person.type(screen.getByLabelText('City or town'), 'Kitwe');
      await person.click(screen.getByRole('button', { name: 'Save' }));
      expect(await screen.findByText('Enter a city or town of up to 80 characters, or leave it empty.')).toBeInTheDocument();
      expect(screen.getByLabelText('City or town')).toHaveAttribute('aria-invalid', 'true');

      await person.click(screen.getByRole('button', { name: 'Save' }));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Look Up is busy. Please try again.');
      expect(alert).toHaveTextContent('Reference: cafe5678');
    });
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
