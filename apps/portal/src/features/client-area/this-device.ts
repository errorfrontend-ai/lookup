import { ApiError } from '../../api/api-client';
import { reportClientError } from '../../app/error-reporting';
import { portalApi } from '../../app/portal-api';

/**
 * This browser and push notifications (ADR-006 decision 7): whether it can have them, asking permission only when the
 * person taps "Turn on notifications" (never on page load), and the subscription sent to the API. Every browser call is
 * guarded: a browser without push simply says so, and nothing breaks.
 */

export const SERVICE_WORKER_PATH = '/service-worker.js';
const MANIFEST_PATH = '/manifest.webmanifest';

/** SUPPORTED; NEEDS_HOME_SCREEN on an iPhone or iPad until Look Up is added to the Home Screen; else NOT_SUPPORTED. */
export type PushSupport = 'SUPPORTED' | 'NEEDS_HOME_SCREEN' | 'NOT_SUPPORTED';

/** An iPhone or iPad (iPadOS reports itself as a Mac with a touch screen). */
export function isAppleMobile(): boolean {
  const userAgent = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && navigator.maxTouchPoints > 1);
}

/** Whether the portal is open as an installed app (from the Home Screen or the app list). */
export function isInstalled(): boolean {
  try {
    return window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

export function pushSupport(): PushSupport {
  const hasPush = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (hasPush) return 'SUPPORTED';
  return isAppleMobile() && !isInstalled() ? 'NEEDS_HOME_SCREEN' : 'NOT_SUPPORTED';
}

/** The browser's answer so far: 'default' (never asked), 'granted' or 'denied'. */
export function notificationPermission(): NotificationPermission | null {
  return 'Notification' in window ? Notification.permission : null;
}

/** Makes the client area installable: the manifest is offered only here, so the station's pages are never an "app". */
export function offerTheManifest(): void {
  if (document.querySelector(`link[rel="manifest"][href="${MANIFEST_PATH}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'manifest';
  link.href = MANIFEST_PATH;
  document.head.append(link);
}

/** The client area's service worker, registered when first needed. */
export async function serviceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  await navigator.serviceWorker.register(SERVICE_WORKER_PATH);
  return navigator.serviceWorker.ready;
}

/** This device's subscription, if notifications are on here. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== 'SUPPORTED') return null;
  const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_PATH);
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/** The server's public key as the bytes PushManager wants. */
export function applicationServerKeyOf(publicKey: string): Uint8Array<ArrayBuffer> {
  const base64 = publicKey.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * "Turn on notifications": the browser asks permission now, and only now; when it is given, this device subscribes with
 * the server's key and the subscription goes to the API. BLOCKED when the person (or the browser) said no.
 */
export async function turnOnThisDevice(publicKey: string): Promise<'ON' | 'BLOCKED'> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'BLOCKED';
  const registration = await serviceWorker();
  if (!registration) return 'BLOCKED';
  const options = { userVisibleOnly: true, applicationServerKey: applicationServerKeyOf(publicKey) };
  let subscription: PushSubscription;
  try {
    subscription = await registration.pushManager.subscribe(options);
  } catch (problem) {
    // A subscription made with an earlier server key cannot be reused: it is replaced.
    const earlier = await registration.pushManager.getSubscription();
    if (!earlier) throw problem;
    await earlier.unsubscribe();
    subscription = await registration.pushManager.subscribe(options);
  }
  const { endpoint, keys } = subscription.toJSON();
  await portalApi.post('/client/push-subscriptions', { endpoint, keys });
  return 'ON';
}

/** "Turn off on this device": the API forgets this device, then the browser lets the subscription go. */
export async function turnOffThisDevice(): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await portalApi.post('/client/push-subscriptions/removal', { endpoint: subscription.endpoint });
  await subscription.unsubscribe();
}

/**
 * A failure of the browser itself while turning notifications on or off (a refused registration, a push service the
 * browser could not reach) goes to the developers as a crash report: its kind, its words and its stack, never a device
 * address. An API refusal is not reported again: the API logged it under its request id.
 */
export function reportDeviceFailure(problem: unknown): void {
  if (problem instanceof ApiError) return;
  const failure = problem instanceof Error ? problem : new Error(String(problem));
  void reportClientError({ kind: 'reported', message: `notifications on this device: ${failure.name}: ${failure.message}`, stack: failure.stack });
}

/** The browser's install offer (Chrome, Edge and Android), kept from the moment it comes until the person uses it. */
interface InstallOffer extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let installOffer: InstallOffer | null = null;
const installOfferListeners = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    // The browser's own banner waits; the client area offers "Install the app" where it explains why.
    event.preventDefault();
    installOffer = event as InstallOffer;
    for (const listener of installOfferListeners) listener();
  });
  window.addEventListener('appinstalled', () => {
    installOffer = null;
    for (const listener of installOfferListeners) listener();
  });
}

export function hasInstallOffer(): boolean {
  return installOffer !== null;
}

export function onInstallOfferChange(listener: () => void): () => void {
  installOfferListeners.add(listener);
  return () => installOfferListeners.delete(listener);
}

/** Shows the browser's install question; true when the person installed it. */
export async function install(): Promise<boolean> {
  if (!installOffer) return false;
  const offer = installOffer;
  installOffer = null;
  await offer.prompt();
  const choice = await offer.userChoice;
  for (const listener of installOfferListeners) listener();
  return choice.outcome === 'accepted';
}
