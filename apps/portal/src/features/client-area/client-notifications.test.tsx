import type { ClientNotificationSettings, SignedInPortalUser } from '@lookup/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../app/portal-api';
import { findAccessibilityProblems } from '../../test/accessibility';
import { errorResponse, installFakeApi, jsonResponse, signedInUserWith } from '../../test/fake-api';
import { renderPortalAt } from '../../test/render-portal';

const person = userEvent.setup({ delay: null });
const STATION = '0190f1a2-0000-7000-8000-00000000c0a1';
const AD = '0190f1a2-0000-7000-8000-00000000ad01';
const OTHER_AD = '0190f1a2-0000-7000-8000-00000000ad02';
const PUBLIC_KEY = 'B'.repeat(87);

const client: SignedInPortalUser = {
  ...signedInUserWith([]),
  clientAccesses: [{ stationId: STATION, stationName: 'Station A', frequencyLabel: '98.1 FM', clientId: '0190f1a2-0000-7000-8000-00000000c1a1', clientName: 'Brand A' }],
};
const settings = (changes: Partial<ClientNotificationSettings> = {}): ClientNotificationSettings => ({
  isPushOn: false,
  isEmailOn: false,
  leadMinutes: 15,
  mutedAds: [],
  isPushAvailable: true,
  pushPublicKey: PUBLIC_KEY,
  ads: [
    { stationId: STATION, stationName: 'Station A', adId: AD, title: 'Summer service offer' },
    { stationId: STATION, stationName: 'Station A', adId: OTHER_AD, title: 'Spring promo' },
  ],
  ...changes,
});

/** A browser with push: its permission, its service worker and the subscription PushManager gives. */
function browserWithPush(options: { permission?: NotificationPermission; answer?: NotificationPermission; isSubscribed?: boolean } = {}) {
  const subscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/device-1',
    toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/device-1', expirationTime: null, keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) } }),
    unsubscribe: vi.fn(async () => true),
  };
  let current: typeof subscription | null = options.isSubscribed ? subscription : null;
  const pushManager = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async () => {
      current = subscription;
      return subscription;
    }),
  };
  const registration = { pushManager };
  class FakeNotification {
    static permission: NotificationPermission = options.permission ?? 'default';
    static requestPermission = vi.fn(async () => {
      FakeNotification.permission = options.answer ?? 'granted';
      return FakeNotification.permission;
    });
  }
  vi.stubGlobal('Notification', FakeNotification);
  vi.stubGlobal('PushManager', function PushManager() {});
  const serviceWorker = { register: vi.fn(async () => registration), ready: Promise.resolve(registration), getRegistration: vi.fn(async () => registration) };
  Object.defineProperty(navigator, 'serviceWorker', { value: serviceWorker, configurable: true });
  return { FakeNotification, pushManager, serviceWorker, subscription };
}

function withoutPush() {
  Reflect.deleteProperty(navigator, 'serviceWorker');
  Reflect.deleteProperty(window, 'Notification');
  Reflect.deleteProperty(window, 'PushManager');
}

function clientApi(initial: ClientNotificationSettings, extra: Parameters<typeof installFakeApi>[0] = {}) {
  let current = initial;
  return installFakeApi({
    'GET /auth/me': () => jsonResponse(200, client),
    'GET /client/notification-settings': () => jsonResponse(200, current),
    'PUT /client/notification-settings': (body) => {
      current = { ...current, ...(body as Partial<ClientNotificationSettings>) };
      return jsonResponse(200, current);
    },
    'POST /client/push-subscriptions': () => new Response(null, { status: 204 }),
    'POST /client/push-subscriptions/removal': () => new Response(null, { status: 204 }),
    'GET /client/home': () => jsonResponse(200, { stations: [] }),
    ...extra,
  });
}

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
  withoutPush();
});

describe('notifications on this device', () => {
  it('P5C-NOTIFY-02: the browser is asked only after "Turn on notifications"; then this device subscribes with the server key, is sent to the API, and push is on', async () => {
    const browser = browserWithPush();
    const api = clientApi(settings());
    renderPortalAt('/client/notifications');
    const device = await screen.findByRole('region', { name: 'On this device' });
    const turnOn = await within(device).findByRole('button', { name: 'Turn on notifications' });
    expect(browser.FakeNotification.requestPermission).not.toHaveBeenCalled();
    await person.click(turnOn);
    expect(await within(device).findByText('Notifications are on for this device.')).toBeInTheDocument();
    expect(browser.FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    const [options] = browser.pushManager.subscribe.mock.calls[0] as unknown as [{ userVisibleOnly: boolean; applicationServerKey: Uint8Array }];
    expect(options.userVisibleOnly).toBe(true);
    expect(options.applicationServerKey).toHaveLength(65);
    expect(api.calls.find((call) => call.path === '/client/push-subscriptions')?.body).toEqual({ endpoint: 'https://fcm.googleapis.com/fcm/send/device-1', keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) } });
    await waitFor(() => expect(api.calls.find((call) => call.method === 'PUT')?.body).toMatchObject({ isPushOn: true }));
    expect(await findAccessibilityProblems()).toEqual([]);
  });

  it('P5C-NOTIFY-02: a refusal is explained with how to allow it, and nothing is sent', async () => {
    browserWithPush({ answer: 'denied' });
    const api = clientApi(settings());
    renderPortalAt('/client/notifications');
    const device = await screen.findByRole('region', { name: 'On this device' });
    await person.click(await within(device).findByRole('button', { name: 'Turn on notifications' }));
    expect(await within(device).findByText(/Notifications are blocked for Look Up in this browser\. To allow them, open the site's settings/)).toBeInTheDocument();
    expect(api.calls.some((call) => call.path === '/client/push-subscriptions')).toBe(false);
  });

  it('P5C-NOTIFY-02: a browser that fails to register shows plain words only, and the failure is reported to the developers', async () => {
    const browser = browserWithPush();
    browser.pushManager.subscribe.mockRejectedValue(new DOMException('Registration failed - push service error', 'AbortError'));
    const api = clientApi(settings(), { 'POST /client-errors': () => new Response(null, { status: 204 }) });
    renderPortalAt('/client/notifications');
    const device = await screen.findByRole('region', { name: 'On this device' });
    await person.click(await within(device).findByRole('button', { name: 'Turn on notifications' }));
    const notice = await within(device).findByRole('alert');
    expect(notice).toHaveTextContent("We couldn't change notifications on this device");
    expect(notice).toHaveTextContent('Something went wrong. Please try again.');
    expect(notice.textContent).not.toMatch(/AbortError|Registration failed|push service/);
    await waitFor(() => expect(api.calls.find((call) => call.path === '/client-errors')?.body).toMatchObject({ kind: 'reported', message: expect.stringContaining('AbortError') }));
    expect(api.calls.some((call) => call.path === '/client/push-subscriptions')).toBe(false);
  });

  it('P5C-NOTIFY-02: blocked before is said at once, without asking again', async () => {
    const browser = browserWithPush({ permission: 'denied' });
    clientApi(settings());
    renderPortalAt('/client/notifications');
    expect(await screen.findByText(/Notifications are blocked for Look Up in this browser/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn on notifications' })).not.toBeInTheDocument();
    expect(browser.FakeNotification.requestPermission).not.toHaveBeenCalled();
  });

  it('P5C-NOTIFY-02: a browser without push says so in plain words, and email still works', async () => {
    withoutPush();
    const api = clientApi(settings());
    renderPortalAt('/client/notifications');
    expect(await screen.findByText("This browser can't show notifications. Open Look Up in Chrome, or turn on email reminders below.")).toBeInTheDocument();
    await person.click(screen.getByRole('switch', { name: 'Email me a reminder too' }));
    await waitFor(() => expect(api.calls.find((call) => call.method === 'PUT')?.body).toMatchObject({ isEmailOn: true }));
  });

  it('P5C-NOTIFY-02, P5C-INSTALL-02: on an iPhone not yet on the Home Screen, the steps to add it come first', async () => {
    withoutPush();
    const userAgent = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1');
    try {
      clientApi(settings());
      renderPortalAt('/client/notifications');
      const device = await screen.findByRole('region', { name: 'On this device' });
      expect(within(device).getByText('On iPhone and iPad, notifications work once Look Up is on your Home Screen:')).toBeInTheDocument();
      expect(within(device).getByText('Choose Add to Home Screen, then Add.')).toBeInTheDocument();
      // Once, not twice.
      expect(screen.getAllByText('Choose Add to Home Screen, then Add.')).toHaveLength(1);
    } finally {
      userAgent.mockRestore();
    }
  });

  it('P5C-NOTIFY-06: without push on the server, the device switch is hidden and reminders are offered by email', async () => {
    browserWithPush();
    clientApi(settings({ isPushAvailable: false, pushPublicKey: null }));
    renderPortalAt('/client/notifications');
    expect(await screen.findByText("Notifications on this device aren't available yet. Reminders can come by email: turn on email reminders below.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn on notifications' })).not.toBeInTheDocument();
  });

  it('P5C-NOTIFY-01: a device that is on can be turned off: the API forgets it, then the browser lets it go', async () => {
    const browser = browserWithPush({ permission: 'granted', isSubscribed: true });
    const api = clientApi(settings({ isPushOn: true }));
    renderPortalAt('/client/notifications');
    const device = await screen.findByRole('region', { name: 'On this device' });
    await person.click(await within(device).findByRole('button', { name: 'Turn off on this device' }));
    expect(await within(device).findByRole('button', { name: 'Turn on notifications' })).toBeInTheDocument();
    expect(api.calls.find((call) => call.path === '/client/push-subscriptions/removal')?.body).toEqual({ endpoint: 'https://fcm.googleapis.com/fcm/send/device-1' });
    expect(browser.subscription.unsubscribe).toHaveBeenCalled();
  });
});

describe('reminder settings', () => {
  it('P5C-ONBOARDING-06: with no access left, the Notifications page explains it as the client home does', async () => {
    withoutPush();
    clientApi(settings(), { 'GET /client/notification-settings': () => errorResponse(404, 'NOT_FOUND', 'We could not find that.') });
    renderPortalAt('/client/notifications');
    expect(await screen.findByRole('heading', { name: "You can't view any adverts right now" })).toBeInTheDocument();
    expect(screen.queryByText("We couldn't load your notifications")).not.toBeInTheDocument();
    expect(screen.queryByText(/Not found|could not find/i)).not.toBeInTheDocument();
  });

  it('P5C-NOTIFY-01, P5C-DASHBOARD-10: email, how early and each advert are saved as they change, in 48 px rows', async () => {
    withoutPush();
    const api = clientApi(settings());
    renderPortalAt('/client/notifications');
    await person.click(await screen.findByRole('switch', { name: 'Email me a reminder too' }));
    await waitFor(() => expect(api.calls.filter((call) => call.method === 'PUT').at(-1)?.body).toMatchObject({ isEmailOn: true }));
    expect(screen.getByRole('radio', { name: '15 minutes' })).toBeChecked();
    await person.click(screen.getByRole('radio', { name: '30 minutes' }));
    await waitFor(() => expect(api.calls.filter((call) => call.method === 'PUT').at(-1)?.body).toMatchObject({ isEmailOn: true, leadMinutes: 30 }));
    const advert = screen.getByRole('switch', { name: 'Spring promo' });
    expect(advert).toBeChecked();
    await person.click(advert);
    await waitFor(() => expect(api.calls.filter((call) => call.method === 'PUT').at(-1)?.body).toEqual({ isPushOn: false, isEmailOn: true, leadMinutes: 30, mutedAds: [{ stationId: STATION, adId: OTHER_AD }] }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    for (const row of [screen.getByRole('switch', { name: 'Spring promo' }).closest('label'), screen.getByRole('radio', { name: '5 minutes' }).closest('label')]) expect(row?.className).toContain('min-h-12');
    expect(await findAccessibilityProblems()).toEqual([]);
  });

  it('a change that cannot be saved says so, with the reference', async () => {
    withoutPush();
    clientApi(settings(), { 'PUT /client/notification-settings': () => errorResponse(500, 'INTERNAL', 'Something went wrong on our side. Please try again.', 'ref-9') });
    renderPortalAt('/client/notifications');
    await person.click(await screen.findByRole('switch', { name: 'Email me a reminder too' }));
    expect(await screen.findByText("We couldn't save that change")).toBeInTheDocument();
  });

  it.each([
    [2, 'and the email', 'Sent to 2 devices and your email.'],
    [1, 'without the email', 'Sent to 1 device.'],
    [0, 'and the email', 'Sent to your email.'],
    [0, 'without the email', 'Nothing to send to yet: turn on notifications on this device, or email reminders.'],
  ])('P5C-NOTIFY-01: a test notification that reached %i devices %s says "%s"', async (devices, email, words) => {
    withoutPush();
    clientApi(settings(), { 'POST /client/test-notification': () => jsonResponse(200, { devices, isEmailSent: email === 'and the email' }) });
    renderPortalAt('/client/notifications');
    await person.click(await screen.findByRole('button', { name: 'Send a test notification' }));
    expect(await screen.findByText(words)).toBeInTheDocument();
  });
});

describe('installing the app', () => {
  it('P5C-INSTALL-02: when the browser offers it, "Install the app" shows its question; without the offer there is no button', async () => {
    withoutPush();
    clientApi(settings());
    renderPortalAt('/client/notifications');
    await screen.findByRole('heading', { level: 1, name: 'Notifications' });
    expect(screen.queryByRole('button', { name: 'Install the app' })).not.toBeInTheDocument();
    const prompt = vi.fn(async () => undefined);
    const offer = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt, userChoice: Promise.resolve({ outcome: 'accepted' as const }) });
    act(() => {
      window.dispatchEvent(offer);
    });
    expect(offer.defaultPrevented).toBe(true);
    await person.click(await screen.findByRole('button', { name: 'Install the app' }));
    expect(prompt).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Install the app' })).not.toBeInTheDocument());
  });

  it('P5C-INSTALL-01: the client area offers the manifest and registers the service worker; the station pages do neither', async () => {
    const browser = browserWithPush();
    clientApi(settings());
    renderPortalAt('/client/notifications');
    await screen.findByRole('heading', { level: 1, name: 'Notifications' });
    await waitFor(() => expect(browser.serviceWorker.register).toHaveBeenCalledWith('/service-worker.js'));
    expect(document.head.querySelector('link[rel="manifest"]')?.getAttribute('href')).toBe('/manifest.webmanifest');
  });

  it('P5C-NOTIFY-02: the home offers reminders while this browser has never been asked, and not once it has', async () => {
    browserWithPush({ permission: 'default' });
    const stations = { stations: [{ stationId: STATION, stationName: 'Station A', frequencyLabel: '98.1 FM', timeZone: 'Africa/Lusaka', contact: { name: null, phoneNumberE164: null }, clients: [], nextOnAir: null, lastSevenDays: { heard: 0, calls: 0, whatsApp: 0, directions: 0, website: 0 }, ads: [] }] };
    clientApi(settings(), { 'GET /client/home': () => jsonResponse(200, stations) });
    renderPortalAt('/client');
    const card = await screen.findByRole('region', { name: 'Get a notification before your adverts air' });
    expect(within(card).getByRole('link', { name: 'Set up reminders' })).toHaveAttribute('href', '/client/notifications');
  });
});

describe('a station member’s pages', () => {
  it('P5C-INSTALL-01: offer no manifest and register no service worker', async () => {
    document.head.querySelector('link[rel="manifest"]')?.remove();
    const browser = browserWithPush();
    const owner = signedInUserWith([{ role: 'OWNER' }]);
    const stationId = owner.stations[0]?.id as string;
    installFakeApi({ 'GET /auth/me': () => jsonResponse(200, owner), [`GET /stations/${stationId}/clients`]: () => jsonResponse(200, []) });
    renderPortalAt(`/stations/${stationId}/clients`);
    await screen.findByRole('heading', { level: 1, name: 'Clients' });
    expect(document.head.querySelector('link[rel="manifest"]')).toBeNull();
    expect(browser.serviceWorker.register).not.toHaveBeenCalled();
  });
});
