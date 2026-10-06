import type { AdDetail, AdHistoryEvent, AdHistoryPage } from '@lookup/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../app/portal-api';
import { adDetail, campaignSummary, historyEvent, overviewFor, scheduleFixture } from '../../test/ad-fixtures';
import { errorResponse, INTERNAL_DETAIL_PATTERN, installFakeApi, jsonResponse, signedInUserWith } from '../../test/fake-api';
import { renderPortalAt } from '../../test/render-portal';

const person = userEvent.setup({ delay: null });
const owner = signedInUserWith([{ role: 'OWNER', name: 'Radio Phoenix', frequencyLabel: '89.5 FM' }]);
const stationId = owner.stations[0]?.id as string;

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface DetailSetup {
  ad?: AdDetail;
  history?: AdHistoryPage[];
  user?: ReturnType<typeof signedInUserWith>;
  extra?: Parameters<typeof installFakeApi>[0];
}

/** The fake API for one ad's page. The history answers with the pages given, in order. */
function installAdPage({ ad = adDetail({ title: 'Summer service offer' }), history = [{ events: [], nextCursor: null }], user = owner, extra = {} }: DetailSetup = {}) {
  const sessionStationId = user.stations[0]?.id as string;
  let historyPage = 0;
  const fakeApi = installFakeApi({
    'GET /auth/me': () => jsonResponse(200, user),
    [`GET /stations/${sessionStationId}/overview`]: () => jsonResponse(200, overviewFor([ad])),
    [`GET /stations/${sessionStationId}/ads/${ad.id}`]: () => jsonResponse(200, ad),
    [`GET /stations/${sessionStationId}/ads/${ad.id}/history`]: () => jsonResponse(200, history[Math.min(historyPage++, history.length - 1)]),
    ...extra,
  });
  return { ad, fakeApi, adPath: `/stations/${sessionStationId}/ads/${ad.id}` };
}

describe('Ad page', () => {
  describe('overview', () => {
    it('shows the ad with its client, status, audio, schedule and what listeners see', async () => {
      const { adPath } = installAdPage();
      renderPortalAt(adPath);

      expect(await screen.findByRole('heading', { level: 1, name: 'Summer service offer' })).toBeInTheDocument();
      expect(screen.getAllByText('Brand A').length).toBeGreaterThan(0);
      expect(screen.getAllByText('On air now').length).toBeGreaterThan(0);

      const audio = screen.getByRole('region', { name: 'Audio' });
      expect(within(audio).getByRole('button', { name: 'Play Summer service offer' })).toBeInTheDocument();
      expect(within(audio).getByText('Audio checked')).toBeInTheDocument();
      expect(within(audio).getByText(/offer\.mp3 · 94 KB · uploaded 38 min ago/)).toBeInTheDocument();

      const airs = screen.getByRole('region', { name: 'When it airs' });
      expect(within(airs).getByText('1 – 31 Oct')).toBeInTheDocument();
      expect(within(airs).getByText('Mon–Fri · 07:00–09:00')).toBeInTheDocument();
      expect(within(airs).getByText('10 hours a week · in station time (Africa/Lusaka)')).toBeInTheDocument();
      expect(within(airs).getByText('10 minutes after each slot')).toBeInTheDocument();
      expect(within(airs).getByText('None')).toBeInTheDocument();

      const preview = screen.getByRole('region', { name: 'What listeners see' });
      expect(within(preview).getByText('Brand A · via Radio Phoenix · 89.5 FM')).toBeInTheDocument();
      expect(within(preview).getByText('Call Brand A')).toBeInTheDocument();
    });

    it('says plainly what is missing: no buttons, no schedule', async () => {
      const { adPath } = installAdPage({ ad: adDetail({ title: 'Bare ad', actionCard: null, schedule: null, campaign: null }) });
      renderPortalAt(adPath);
      expect(await screen.findByText(/This ad has no buttons yet/)).toBeInTheDocument();
      expect(screen.getByText(/Not scheduled yet\. Set when this ad airs/)).toBeInTheDocument();
    });

    it('explains a refused upload in words, and offers no player for audio that never arrived', async () => {
      const { adPath } = installAdPage({ ad: adDetail({ title: 'Refused', status: 'FAILED', processingErrorCode: 'not_the_declared_audio_format', uploadedAt: null, campaign: null, schedule: null }) });
      renderPortalAt(adPath);
      const audio = await screen.findByRole('region', { name: 'Audio' });
      expect(within(audio).getByText("This file isn't a valid MP3, WAV or M4A audio file. Choose a different file.")).toBeInTheDocument();
      expect(within(audio).queryByRole('button', { name: /^Play/ })).not.toBeInTheDocument();
    });

    it('shows the latest three changes, and links to the full history', async () => {
      const events = [
        historyEvent({ kind: 'ad_published', isRepublish: false }),
        historyEvent({ kind: 'schedule_saved', isFirstSave: true, changedParts: [] }),
        historyEvent({ kind: 'buttons_saved', isFirstSave: true, buttonChanges: [] }),
        historyEvent({ kind: 'ad_created', fileName: 'offer.mp3' }),
      ];
      const { adPath } = installAdPage({ history: [{ events, nextCursor: null }] });
      renderPortalAt(adPath);
      const recent = await screen.findByRole('region', { name: 'Recent changes' });
      await waitFor(() => expect(within(recent).getByText(/published the ad/)).toBeInTheDocument());
      expect(within(recent).getAllByRole('listitem')).toHaveLength(3);
      expect(within(recent).queryByText(/created the ad/)).not.toBeInTheDocument();
      expect(within(recent).getByRole('link', { name: 'Full history' })).toHaveAttribute('href', expect.stringMatching(/\?tab=history$/));
    });
  });

  describe('states', () => {
    it('says it cannot find an ad that is not there, with a way back', async () => {
      const unknownId = '0190f1a2-0000-7000-8000-0000000000ff';
      installFakeApi({
        'GET /auth/me': () => jsonResponse(200, owner),
        [`GET /stations/${stationId}/overview`]: () => jsonResponse(200, overviewFor([])),
        [`GET /stations/${stationId}/ads/${unknownId}`]: () => errorResponse(404, 'NOT_FOUND', 'We could not find that.'),
      });
      renderPortalAt(`/stations/${stationId}/ads/${unknownId}`);
      expect(await screen.findByRole('heading', { name: "We couldn't find that ad" })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Go to your ads' })).toHaveAttribute('href', `/stations/${stationId}/ads`);
    });

    it('explains any other failure with its reference, and tries again on request', async () => {
      const ad = adDetail({ title: 'Flaky' });
      let attempts = 0;
      installFakeApi({
        'GET /auth/me': () => jsonResponse(200, owner),
        [`GET /stations/${stationId}/overview`]: () => jsonResponse(200, overviewFor([ad])),
        [`GET /stations/${stationId}/ads/${ad.id}/history`]: () => jsonResponse(200, { events: [], nextCursor: null }),
        [`GET /stations/${stationId}/ads/${ad.id}`]: () => {
          attempts += 1;
          return attempts === 1 ? errorResponse(500, 'INTERNAL', 'Something went wrong on our side.', 'deadbeef') : jsonResponse(200, ad);
        },
      });
      renderPortalAt(`/stations/${stationId}/ads/${ad.id}`);
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent("We couldn't load this ad");
      expect(alert).toHaveTextContent('Reference: deadbeef');
      expect(document.body.textContent).not.toMatch(INTERNAL_DETAIL_PATTERN);
      await person.click(screen.getByRole('button', { name: 'Try again' }));
      expect(await screen.findByRole('heading', { level: 1, name: 'Flaky' })).toBeInTheDocument();
    });
  });

  describe('tabs live in the address', () => {
    it('opens the tab named in the address, falls back to Overview for an unknown one, and marks the current tab', async () => {
      const { adPath, ad } = installAdPage();
      const first = renderPortalAt(`${adPath}?tab=schedule`);
      expect(await screen.findByRole('region', { name: 'The week' })).toBeInTheDocument();
      const tabs = screen.getByRole('navigation', { name: 'Ad sections' });
      expect(within(tabs).getAllByRole('link').map((link) => link.textContent)).toEqual(['Overview', 'Buttons', 'Schedule', 'History']);
      expect(within(tabs).getByRole('link', { name: 'Schedule' })).toHaveAttribute('aria-current', 'page');
      first.unmount();
      queryClient.clear();

      installAdPage({ ad });
      renderPortalAt(`${adPath}?tab=bogus`);
      expect(await screen.findByRole('region', { name: 'Audio' })).toBeInTheDocument();
    });

    it('choosing a tab changes the address', async () => {
      const { adPath } = installAdPage();
      const { router } = renderPortalAt(adPath);
      await screen.findByRole('region', { name: 'Audio' });
      await person.click(screen.getByRole('link', { name: 'Buttons' }));
      await waitFor(() => expect(router.state.location.search).toBe('?tab=buttons'));
      expect(await screen.findByRole('region', { name: 'Buttons' })).toBeInTheDocument();
    });
  });

  describe('buttons tab', () => {
    it('writes out where each button goes so the station can check it, and offers to try each one', async () => {
      const { adPath } = installAdPage();
      renderPortalAt(`${adPath}?tab=buttons`);
      const buttons = await screen.findByRole('region', { name: 'Buttons' });
      const items = within(buttons).getAllByRole('listitem');
      expect(items).toHaveLength(3);
      expect(within(items[0] as HTMLElement).getByText('Call Brand A')).toBeInTheDocument();
      expect(within(items[0] as HTMLElement).getByText('+260 97 712 3456')).toBeInTheDocument();
      expect(within(items[1] as HTMLElement).getByText(/\+260 96 600 0111 · first message: “Hello there”/)).toBeInTheDocument();
      expect(within(items[2] as HTMLElement).getByText('Cairo Road, Lusaka (-15.4167, 28.2833)')).toBeInTheDocument();
      expect(within(buttons).getByRole('link', { name: 'Try “Call Brand A”' })).toHaveAttribute('href', 'tel:+260977123456');
      expect(within(buttons).getByRole('link', { name: 'Try “Chat on WhatsApp”' })).toHaveAttribute('href', 'https://wa.me/260966000111?text=Hello%20there');
      expect(within(buttons).getByRole('link', { name: 'Try “Get directions”' })).toHaveAttribute('href', 'https://www.google.com/maps/search/?api=1&query=-15.416700%2C28.283300');
    });

    it('previews at a small and a large phone, with the small one first', async () => {
      const { adPath } = installAdPage();
      renderPortalAt(`${adPath}?tab=buttons`);
      const preview = await screen.findByRole('region', { name: 'What listeners see' });
      expect(within(preview).getByRole('group', { name: /320 pixel wide/ })).toBeInTheDocument();
      expect(within(preview).getByRole('button', { name: 'Small phone · 320' })).toHaveAttribute('aria-pressed', 'true');
      await person.click(within(preview).getByRole('button', { name: 'Large phone · 411' }));
      expect(within(preview).getByRole('group', { name: /411 pixel wide/ })).toBeInTheDocument();
      expect(within(preview).getByRole('button', { name: 'Large phone · 411' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('says when there are no buttons', async () => {
      const { adPath } = installAdPage({ ad: adDetail({ actionCard: null }) });
      renderPortalAt(`${adPath}?tab=buttons`);
      expect(await screen.findByRole('heading', { name: 'No buttons yet' })).toBeInTheDocument();
    });
  });

  describe('schedule tab', () => {
    it('draws the week and writes the schedule out', async () => {
      const ad = adDetail({ schedule: scheduleFixture({ gracePeriodMinutes: 0, engagementLimit: 250, timeWindows: [{ daysOfWeek: [6, 7], localStartTime: '10:00', localEndTime: '14:00' }] }) });
      const { adPath } = installAdPage({ ad });
      renderPortalAt(`${adPath}?tab=schedule`);
      const week = await screen.findByRole('region', { name: 'The week' });
      expect(within(week).getByRole('img', { name: /on air 8 hours a week/ })).toBeInTheDocument();
      const details = screen.getByRole('region', { name: 'Schedule details' });
      expect(within(details).getByText('Sat, Sun · 10:00–14:00')).toBeInTheDocument();
      expect(within(details).getByText('250 taps')).toBeInTheDocument();
      expect(within(details).getByText('None', { selector: 'dd' })).toBeInTheDocument();
    });

    it('says when nothing is scheduled', async () => {
      const { adPath } = installAdPage({ ad: adDetail({ schedule: null, campaign: null }) });
      renderPortalAt(`${adPath}?tab=schedule`);
      expect(await screen.findByRole('heading', { name: 'Not scheduled yet' })).toBeInTheDocument();
    });
  });

  describe('history tab', () => {
    it('lists what happened as sentences with who did it, and offers older changes a page at a time', async () => {
      const newer = [
        historyEvent({ kind: 'buttons_saved', isFirstSave: false, buttonChanges: [{ buttonLabel: 'Chat with us', buttonType: 'WHATSAPP', change: 'changed', changedFields: ['phone_number'] }, { buttonLabel: 'Menu', buttonType: 'LINK', change: 'added', changedFields: [] }] }),
        historyEvent({ kind: 'ad_published', isRepublish: false, actorName: null }),
      ];
      const older = [historyEvent({ kind: 'ad_created', fileName: 'offer.mp3', actorName: 'Mutale Banda' })];
      const { adPath } = installAdPage({ history: [{ events: newer, nextCursor: '999' }, { events: older, nextCursor: null }] });
      renderPortalAt(`${adPath}?tab=history`);

      const history = await screen.findByRole('region', { name: 'History' });
      await waitFor(() => expect(within(history).getAllByRole('listitem')).toHaveLength(3));
      const items = within(history).getAllByRole('listitem');
      expect(items[0]).toHaveTextContent('Chanda Mwale changed the WhatsApp number of “Chat with us”');
      expect(items[1]).toHaveTextContent('Chanda Mwale added the button “Menu”');
      expect(items[2]).toHaveTextContent('A former team member published the ad');
      expect(history.textContent).not.toMatch(/\+260|example|Hello there/);

      await person.click(within(history).getByRole('button', { name: 'Show older changes' }));
      await waitFor(() => expect(within(history).getAllByRole('listitem')).toHaveLength(4));
      expect(within(history).getAllByRole('listitem')[3]).toHaveTextContent('Mutale Banda created the ad with offer.mp3');
      expect(within(history).queryByRole('button', { name: 'Show older changes' })).not.toBeInTheDocument();
    });

    it('says when nothing has been recorded', async () => {
      const { adPath } = installAdPage();
      renderPortalAt(`${adPath}?tab=history`);
      expect(await screen.findByText('Nothing has been recorded for this ad yet.')).toBeInTheDocument();
    });
  });

  describe('renaming', () => {
    it('opens a window with the title, saves the new one, confirms, and shows it', async () => {
      const ad = adDetail({ title: 'Summer offer' });
      let currentTitle = ad.title;
      const { adPath, fakeApi } = installAdPage({
        ad,
        extra: {
          [`GET /stations/${stationId}/ads/${ad.id}`]: () => jsonResponse(200, { ...ad, title: currentTitle }),
          [`PUT /stations/${stationId}/ads/${ad.id}/title`]: (body) => {
            currentTitle = (body as { title: string }).title;
            return jsonResponse(200, { ...ad, title: currentTitle });
          },
        },
      });
      renderPortalAt(adPath);
      await person.click(await screen.findByRole('button', { name: 'Rename' }));

      const dialog = screen.getByRole('dialog', { name: 'Rename this ad' });
      const field = within(dialog).getByLabelText('Ad title');
      expect(field).toHaveValue('Summer offer');
      await person.clear(field);
      await person.type(field, '  Summer service offer  ');
      await person.click(within(dialog).getByRole('button', { name: 'Save title' }));

      expect(await screen.findByRole('heading', { level: 1, name: 'Summer service offer' })).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.getByText('Ad renamed')).toBeInTheDocument();
      expect(fakeApi.calls.find((call) => call.method === 'PUT')?.body).toEqual({ title: 'Summer service offer' });
    });

    it('closes without asking the server when the title is unchanged, and keeps Save off for an empty title', async () => {
      const { adPath, fakeApi } = installAdPage({ ad: adDetail({ title: 'Same title' }) });
      renderPortalAt(adPath);
      await person.click(await screen.findByRole('button', { name: 'Rename' }));
      const dialog = screen.getByRole('dialog');
      await person.clear(within(dialog).getByLabelText('Ad title'));
      expect(within(dialog).getByRole('button', { name: 'Save title' })).toBeDisabled();
      await person.type(within(dialog).getByLabelText('Ad title'), 'Same title');
      await person.click(within(dialog).getByRole('button', { name: 'Save title' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(fakeApi.calls.some((call) => call.method === 'PUT')).toBe(false);
    });

    it('explains a refused title next to the box', async () => {
      const ad = adDetail({ title: 'Original' });
      const { adPath } = installAdPage({
        ad,
        extra: { [`PUT /stations/${stationId}/ads/${ad.id}/title`]: () => errorResponse(400, 'VALIDATION_FAILED', 'Some details are missing or not valid.', 'abc', [{ path: 'title', code: 'too_big' }]) },
      });
      renderPortalAt(adPath);
      await person.click(await screen.findByRole('button', { name: 'Rename' }));
      await person.type(screen.getByLabelText('Ad title'), ' changed');
      await person.click(screen.getByRole('button', { name: 'Save title' }));
      expect(await screen.findByText('Enter a title of 1 to 120 characters.')).toBeInTheDocument();
      expect(screen.getByLabelText('Ad title')).toHaveAttribute('aria-invalid', 'true');
    });
  });

  describe('removing', () => {
    it('asks first, then removes the ad, goes back to the list and confirms', async () => {
      const ad = adDetail({ title: 'Old offer', campaign: null, schedule: null });
      const { adPath, fakeApi } = installAdPage({
        ad,
        extra: {
          [`POST /stations/${stationId}/ads/${ad.id}/archive`]: () => jsonResponse(204, null),
          [`GET /stations/${stationId}/ads`]: () => jsonResponse(200, { ads: [], nextCursor: null }),
          [`GET /stations/${stationId}/clients`]: () => jsonResponse(200, []),
        },
      });
      const { router } = renderPortalAt(adPath);
      await person.click(await screen.findByRole('button', { name: 'Remove ad' }));

      const dialog = screen.getByRole('dialog', { name: 'Remove this ad?' });
      expect(dialog).toHaveTextContent('“Old offer” will disappear from your lists. Its history is kept.');
      expect(fakeApi.calls.some((call) => call.path.endsWith('/archive'))).toBe(false);
      await person.click(within(dialog).getByRole('button', { name: 'Remove ad' }));

      await waitFor(() => expect(router.state.location.pathname).toBe(`/stations/${stationId}/ads`));
      expect(await screen.findByText('“Old offer” removed')).toBeInTheDocument();
      expect(fakeApi.calls.filter((call) => call.path.endsWith('/archive'))).toHaveLength(1);
    });

    it('backing out removes nothing', async () => {
      const { adPath, fakeApi } = installAdPage();
      renderPortalAt(adPath);
      await person.click(await screen.findByRole('button', { name: 'Remove ad' }));
      await person.click(screen.getByRole('button', { name: 'Keep the ad' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(fakeApi.calls.some((call) => call.path.endsWith('/archive'))).toBe(false);
    });

    it('tells the station why a published ad cannot be removed yet, and keeps the ad', async () => {
      const ad = adDetail({ title: 'Live ad' });
      const { adPath, fakeApi } = installAdPage({
        ad,
        extra: { [`POST /stations/${stationId}/ads/${ad.id}/archive`]: () => errorResponse(409, 'CONFLICT', 'This ad is published. It can be removed once its schedule has ended.', 'cafe0001') },
      });
      const { router } = renderPortalAt(adPath);
      await person.click(await screen.findByRole('button', { name: 'Remove ad' }));
      await person.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove ad' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent("We couldn't remove it");
      expect(alert).toHaveTextContent('This ad is published. It can be removed once its schedule has ended.');
      expect(alert).toHaveTextContent('Reference: cafe0001');
      expect(router.state.location.pathname).toBe(adPath);
      expect(fakeApi.calls.filter((call) => call.path.endsWith('/archive'))).toHaveLength(1);
    });
  });

  describe('who may change an ad', () => {
    it('an analyst reads everything and sees no Rename or Remove', async () => {
      const analyst = signedInUserWith([{ role: 'ANALYST' }]);
      const { adPath } = installAdPage({ user: analyst });
      renderPortalAt(adPath);
      await screen.findByRole('heading', { level: 1, name: 'Summer service offer' });
      expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Remove ad' })).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'History' })).toBeInTheDocument();
    });
  });

  describe('keeping up with the ad', () => {
    it('asks again by itself while the audio is still being received, until it has arrived', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const ad = adDetail({ title: 'Arriving', status: 'AWAITING_UPLOAD', uploadedAt: null, updatedAt: new Date().toISOString(), campaign: null, schedule: null });
        let polls = 0;
        const { adPath } = installAdPage({
          ad,
          extra: {
            [`GET /stations/${stationId}/ads/${ad.id}`]: () => {
              polls += 1;
              return jsonResponse(200, polls < 3 ? ad : { ...ad, status: 'PROCESSING', uploadedAt: new Date().toISOString() });
            },
          },
        });
        renderPortalAt(adPath);
        expect(await screen.findAllByText('Waiting for the audio')).not.toHaveLength(0);
        await vi.advanceTimersByTimeAsync(5_100);
        await vi.advanceTimersByTimeAsync(5_100);
        await waitFor(() => expect(screen.getAllByText('Audio checked').length).toBeGreaterThan(0));
        expect(polls).toBeGreaterThanOrEqual(3);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

/** Keep the type imports referenced so a future change to these shapes shows up here. */
export type { AdHistoryEvent };
void campaignSummary;
