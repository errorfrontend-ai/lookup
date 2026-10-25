import { z } from 'zod';
import type { ActionCard } from '../action-card/action-card-schema.js';
import type { CampaignDisplayStatus } from '../ads/ad-schemas.js';
import { EmailAddress } from '../registration/email-address.js';
import { LISTENER_FIGURES_RANGES, type ListenerFiguresRange } from '../stations/listener-figures-schemas.js';

/**
 * Client accounts (ADR-006, docs/design/step-5c-client-accounts.md): the business that pays for an advert follows it.
 * A station grants access by email invitation; the person then sees, for each station, that client's published adverts,
 * when they air, how listeners responded and who is listening (in groups), and chooses their air-time reminders.
 */

// ---- the station's side -----------------------------------------------------------------------------------------------

/** POST /stations/{stationId}/clients/{clientId}/viewers/invitations */
export const InviteClientViewerInput = z.strictObject({ email: EmailAddress });
export type InviteClientViewerInput = z.infer<typeof InviteClientViewerInput>;

/** GET /stations/{stationId}/clients/{clientId}/viewers: who can view one client's adverts, and who is invited. */
export interface ClientViewerAccessList {
  clientId: string;
  clientName: string;
  people: Array<{ portalUserId: string; fullName: string; email: string; joinedAt: string }>;
  pendingInvitations: Array<{ id: string; email: string; invitedAt: string; expiresAt: string; isExpired: boolean }>;
  /** True for an owner or manager: the dialog shows the invite, send-again, cancel and remove controls. */
  canManage: boolean;
}

// ---- the client's side ------------------------------------------------------------------------------------------------

/** One client a person follows at one station (in `GET /auth/me`). */
export interface ClientAccess {
  stationId: string;
  stationName: string | null;
  frequencyLabel: string | null;
  clientId: string;
  clientName: string;
}

/** The button types listeners tap, as the client's figures name them. */
export const CLIENT_BUTTON_TYPES = ['CALL', 'WHATSAPP', 'MAP', 'LINK'] as const;
export type ClientButtonType = (typeof CLIENT_BUTTON_TYPES)[number];

/** How listeners responded: identifications ("heard") and taps by button type. */
export interface ClientFigures {
  heard: number;
  calls: number;
  whatsApp: number;
  directions: number;
  website: number;
}

/** One time slot of an advert, as the station's clock shows it, with the instants it starts and ends. */
export interface ClientSlot {
  startsAt: string;
  endsAt: string;
  /** YYYY-MM-DD, the station's day the slot starts on. */
  localDate: string;
  /** HH:MM, station time. */
  localStartTime: string;
  localEndTime: string;
}

/** A published campaign's state: a draft is the station's work in progress and is never shown to a client. */
export type ClientAdStatus = Exclude<CampaignDisplayStatus, 'DRAFT'>;

export interface ClientAdSummary {
  id: string;
  title: string;
  clientId: string;
  clientName: string;
  status: ClientAdStatus;
  /** YYYY-MM-DD, the station's first and last day of the campaign. */
  startsOn: string;
  endsOn: string;
  timeWindows: Array<{ daysOfWeek: number[]; localStartTime: string; localEndTime: string }>;
  heardLastSevenDays: number;
  /** The next slot, within 14 days, while the campaign is active. */
  nextOnAir: ClientSlot | null;
}

/** A station's contact, for "To change this ad, contact …". */
export interface ClientStationContact {
  name: string | null;
  phoneNumberE164: string | null;
}

/** One station on the client home: its own figures and adverts, never added to another station's. */
export interface ClientStationSection {
  stationId: string;
  stationName: string | null;
  frequencyLabel: string | null;
  /** The station's IANA time zone: its slots, days and "today" are in this zone. */
  timeZone: string;
  contact: ClientStationContact;
  /** The clients the person follows at this station (usually one). */
  clients: Array<{ id: string; name: string }>;
  nextOnAir: (ClientSlot & { adId: string; adTitle: string }) | null;
  lastSevenDays: ClientFigures;
  ads: ClientAdSummary[];
}

/** GET /client/home */
export interface ClientHome {
  stations: ClientStationSection[];
}

/** GET /client/stations/{stationId}/ads/{adId} */
export interface ClientAdDetail extends ClientAdSummary {
  station: { id: string; name: string | null; frequencyLabel: string | null; timeZone: string; contact: ClientStationContact };
  actionCard: ActionCard | null;
  /** The next 5 slots within 14 days. */
  nextTimesOnAir: ClientSlot[];
}

/** GET /client/stations/{stationId}/ads/{adId}/figures?range= and …/listener-mix?range= */
export const ClientFiguresQuery = z.strictObject({ range: z.enum(LISTENER_FIGURES_RANGES).default('last7Days') });
export type ClientFiguresQuery = z.infer<typeof ClientFiguresQuery>;

/** GET /client/stations/{stationId}/export.csv?range=: the last 30 days unless another range is asked. */
export const ClientSpreadsheetQuery = z.strictObject({ range: z.enum(LISTENER_FIGURES_RANGES).default('last30Days') });
export type ClientSpreadsheetQuery = z.infer<typeof ClientSpreadsheetQuery>;

export interface ClientAdFigures extends ClientFigures {
  range: ListenerFiguresRange;
  firstDay: string;
  lastDay: string;
}

// ---- notifications ------------------------------------------------------------------------------------------------------

/** How long before a slot starts its reminder goes out (ADR-006 decision 6). */
export const AIR_TIME_REMINDER_LEAD_MINUTES = [5, 15, 30] as const;
export type AirTimeReminderLeadMinutes = (typeof AIR_TIME_REMINDER_LEAD_MINUTES)[number];
export const DEFAULT_AIR_TIME_REMINDER_LEAD_MINUTES: AirTimeReminderLeadMinutes = 15;

/** PUT /client/notification-settings */
export const ClientNotificationSettingsInput = z.strictObject({
  isPushOn: z.boolean(),
  isEmailOn: z.boolean(),
  leadMinutes: z.union([z.literal(5), z.literal(15), z.literal(30)]),
  mutedAds: z.array(z.strictObject({ stationId: z.uuid(), adId: z.uuid() })).max(500),
});
export type ClientNotificationSettingsInput = z.infer<typeof ClientNotificationSettingsInput>;

/** GET /client/notification-settings */
export interface ClientNotificationSettings extends ClientNotificationSettingsInput {
  /** False when the server has no push keys: reminders come by email only. */
  isPushAvailable: boolean;
  /** The server's public VAPID key, for the browser's subscription; null when push is not available. */
  pushPublicKey: string | null;
  /** Every advert the person follows, by station, for the per-advert switches. */
  ads: Array<{ stationId: string; stationName: string | null; adId: string; title: string }>;
}

/**
 * The browsers' own push services: Chrome and other Chromium browsers (Google), Firefox (Mozilla), Safari on iPhone and
 * Mac (Apple), Edge (Microsoft). A device's push address must be on one of them, so a client can never make the server
 * post somewhere else.
 */
const PUSH_SERVICE_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /^[a-z0-9-]{1,63}\.notify\.windows\.com$/];

/** Whether [endpoint] is an https address on a browser's own push service, with no user name, password or port. */
export function isKnownPushServiceEndpoint(endpoint: string): boolean {
  if (endpoint.length > 2048 || !/^https:\/\/\S+$/.test(endpoint)) return false;
  try {
    const address = new URL(endpoint);
    return address.protocol === 'https:' && !address.username && !address.password && !address.port && PUSH_SERVICE_HOSTS.some((host) => host.test(address.hostname));
  } catch {
    return false;
  }
}

const PushEndpoint = z.string().max(2048).regex(/^https:\/\/\S+$/).refine(isKnownPushServiceEndpoint, { message: 'not a browser push service' });

/** POST /client/push-subscriptions: what the browser's PushSubscription gives (its expiry is not used). */
export const PushSubscriptionInput = z.strictObject({
  endpoint: PushEndpoint,
  expirationTime: z.number().nullable().optional(),
  keys: z.strictObject({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{80,100}$/),
    auth: z.string().regex(/^[A-Za-z0-9_-]{16,32}$/),
  }),
});
export type PushSubscriptionInput = z.infer<typeof PushSubscriptionInput>;

/** POST /client/push-subscriptions/removal: this device turned off. */
export const PushSubscriptionRemovalInput = z.strictObject({ endpoint: PushEndpoint });
export type PushSubscriptionRemovalInput = z.infer<typeof PushSubscriptionRemovalInput>;

/** What a test notification reached. */
export interface TestNotificationResult {
  devices: number;
  isEmailSent: boolean;
}
