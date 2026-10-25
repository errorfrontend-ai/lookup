import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const PUBLIC_FOLDER = join(import.meta.dirname, '..', '..', 'public');
const ORIGIN = 'https://lookup.example';

type Handler = (event: Record<string, unknown>) => void;

/** The service worker run against a stand-in for its global scope: the handlers it adds, and what it asks of the browser. */
function loadServiceWorker(windows: Array<{ url: string; navigate: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> }> = []) {
  const handlers = new Map<string, Handler>();
  const scope = {
    addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
    skipWaiting: vi.fn(),
    location: { origin: ORIGIN },
    registration: { showNotification: vi.fn(async () => undefined) },
    clients: { claim: vi.fn(), matchAll: vi.fn(async () => windows), openWindow: vi.fn(async () => null) },
  };
  new Function('self', readFileSync(join(PUBLIC_FOLDER, 'service-worker.js'), 'utf8'))(scope);
  /** Fires one event and waits for what it asked the browser to wait for. */
  const fire = async (type: string, event: Record<string, unknown>) => {
    let waited: Promise<unknown> = Promise.resolve();
    handlers.get(type)?.({ ...event, waitUntil: (promise: Promise<unknown>) => (waited = promise) });
    await waited;
  };
  return { handlers, scope, fire };
}

const pushOf = (payload: unknown) => ({ data: { json: () => (typeof payload === 'string' ? JSON.parse(payload) : payload) } });
const clickOf = (url: unknown) => ({ notification: { close: vi.fn(), data: { url } } });

describe('the service worker', () => {
  it('P5C-INSTALL-01: handles push and notification taps, and caches nothing (no fetch handler)', () => {
    const { handlers } = loadServiceWorker();
    expect([...handlers.keys()].sort()).toEqual(['activate', 'install', 'notificationclick', 'push']);
  });

  it('P5C-NOTIFY-05: shows the notice the server sent, with its tag, and the advert page it opens', async () => {
    const { scope, fire } = loadServiceWorker();
    await fire('push', pushOf({ title: 'Summer service offer airs soon', body: 'On Station A (98.1 FM) between 07:00 and 09:00 today. Listen in to check it.', url: '/client/stations/s1/ads/a1', tag: 'air-time-w1-2026-10-24' }));
    expect(scope.registration.showNotification).toHaveBeenCalledWith('Summer service offer airs soon', {
      body: 'On Station A (98.1 FM) between 07:00 and 09:00 today. Listen in to check it.',
      tag: 'air-time-w1-2026-10-24',
      data: { url: '/client/stations/s1/ads/a1' },
      icon: '/icons/look-up-192.png',
      badge: '/icons/look-up-192.png',
    });
  });

  it.each([
    ['another site', 'https://elsewhere.example/phish'],
    ['a protocol-relative address', '//elsewhere.example/phish'],
    ['a station page', '/stations/s1/ads'],
    ['a script', 'javascript:alert(1)'],
    ['nothing', undefined],
  ])('P5C-NOTIFY-05: a notice pointing at %s opens the client home instead', async (_what, url) => {
    const { scope, fire } = loadServiceWorker();
    await fire('push', pushOf({ title: 'T', body: 'B', url, tag: 't' }));
    expect(scope.registration.showNotification).toHaveBeenCalledWith('T', expect.objectContaining({ data: { url: '/client' } }));
  });

  it('a message that is not a notice still shows Look Up’s own words (a push must show something)', async () => {
    const { scope, fire } = loadServiceWorker();
    await fire('push', { data: { json: () => JSON.parse('not json') } });
    expect(scope.registration.showNotification).toHaveBeenCalledWith('Look Up', expect.objectContaining({ body: 'Open Look Up to see your adverts.', data: { url: '/client' } }));
  });

  it('P5C-NOTIFY-05: a tap opens the advert in the open Look Up window, or a new one', async () => {
    const focused = { focus: vi.fn(async () => undefined) };
    const open = { url: `${ORIGIN}/client`, navigate: vi.fn(async () => focused), focus: vi.fn() };
    const elsewhere = { url: 'https://elsewhere.example/', navigate: vi.fn(), focus: vi.fn() };
    const withWindow = loadServiceWorker([elsewhere, open]);
    const tap = clickOf('/client/stations/s1/ads/a1');
    await withWindow.fire('notificationclick', tap);
    expect(tap.notification.close).toHaveBeenCalled();
    expect(elsewhere.navigate).not.toHaveBeenCalled();
    expect(open.navigate).toHaveBeenCalledWith('/client/stations/s1/ads/a1');
    expect(focused.focus).toHaveBeenCalled();
    expect(withWindow.scope.clients.openWindow).not.toHaveBeenCalled();

    const withoutWindow = loadServiceWorker();
    await withoutWindow.fire('notificationclick', clickOf('https://elsewhere.example/'));
    expect(withoutWindow.scope.clients.openWindow).toHaveBeenCalledWith('/client');
  });
});

describe('the app manifest', () => {
  it('P5C-INSTALL-01: names Look Up, opens the client area as a standalone app in the portal’s accent colour, with 192 and 512 px icons', () => {
    const manifest = JSON.parse(readFileSync(join(PUBLIC_FOLDER, 'manifest.webmanifest'), 'utf8'));
    expect(manifest).toMatchObject({ name: 'Look Up', short_name: 'Look Up', start_url: '/client', scope: '/', display: 'standalone' });
    const tokens = readFileSync(join(import.meta.dirname, '..', 'design', 'design-tokens.css'), 'utf8');
    expect(manifest.theme_color).toBe(/--lookup-color-accent: (#[0-9A-F]{6});/.exec(tokens)?.[1]);
    expect(manifest.background_color).toBe(/--lookup-color-ground: (#[0-9A-F]{6});/.exec(tokens)?.[1]);
    for (const icon of manifest.icons as Array<{ src: string; sizes: string; type: string }>) {
      const png = readFileSync(join(PUBLIC_FOLDER, icon.src));
      expect(png.subarray(1, 4).toString('latin1'), icon.src).toBe('PNG');
      expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, icon.src).toBe(icon.sizes);
      expect(icon.type).toBe('image/png');
    }
    expect(manifest.icons.map((icon: { sizes: string; purpose: string }) => `${icon.sizes} ${icon.purpose}`)).toEqual(['192x192 any', '512x512 any', '512x512 maskable']);
  });
});
