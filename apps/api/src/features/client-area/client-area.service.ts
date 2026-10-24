import {
  type ClientAdDetail,
  type ClientAdFigures,
  type ClientAdStatus,
  type ClientAdSummary,
  type ClientFigures,
  type ClientFiguresQuery,
  type ClientHome,
  type ClientNotificationSettings,
  type ClientNotificationSettingsInput,
  type ClientSlot,
  type ClientSpreadsheetQuery,
  type ClientStationSection,
  LISTENER_FIGURES_RANGE_DAYS,
  type ListenerMix,
} from '@lookup/contracts';
import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { EntityManager } from 'typeorm';
import { AppError } from '../../common/errors/app-error.js';
import { StationScopedTransaction } from '../../infrastructure/database/station-scoped-transaction.js';
import { type ListenerMixRow, toListenerMix } from '../station-overview/listener-mix.service.js';
import { clientSpreadsheet, spreadsheetFileName } from './client-spreadsheet.js';

interface AccessRow {
  station_id: string;
  station_name: string | null;
  station_frequency_label: string | null;
  station_time_zone: string;
  station_contact_name: string | null;
  station_contact_phone_number_e164: string | null;
  client_id: string;
  client_name: string;
}

interface AdRow {
  ad_id: string;
  client_id: string;
  client_name: string;
  title: string;
  campaign_display_status: ClientAdStatus;
  campaign_starts_on: string;
  campaign_ends_on: string;
  campaign_time_windows: ClientAdSummary['timeWindows'] | null;
  heard_last_seven_days?: number;
}

interface FiguresRow {
  ad_id: string;
  first_day: string;
  last_day: string;
  heard: number;
  call_taps: number;
  whatsapp_taps: number;
  map_taps: number;
  link_taps: number;
}

interface SlotRow {
  ad_id: string;
  slot_starts_at: Date;
  slot_ends_at: Date;
  local_date: string;
  local_start_time: string;
  local_end_time: string;
}

/** How far ahead "next on air" looks is set in the database (14 days); how many slots an advert's page lists: */
const NEXT_TIMES_ON_AIR_SHOWN = 5;

/**
 * The client area (ADR-006; design §3.3): what a person who follows a station's client sees. Every read goes through a
 * database function that checks the person's own access and returns only what a client may see; the transaction carries
 * the person and no station, so station row-level security shows them nothing else (P5C-ACCESS-01). Figures stay per
 * station and are never added across stations (P5C-ACCESS-05).
 */
@Injectable()
export class ClientArea {
  constructor(
    private readonly stationScopedTransaction: StationScopedTransaction,
    private readonly requestContext: ClsService,
  ) {}

  /** The person's stations, each with its own figures, next slot and adverts. Nobody followed: no station. */
  home(): Promise<ClientHome> {
    return this.asTheClient(async (database) => {
      const accesses = await this.accesses(database);
      const stations: ClientStationSection[] = [];
      for (const stationId of [...new Set(accesses.map((access) => access.station_id))]) {
        const stationAccesses = accesses.filter((access) => access.station_id === stationId);
        const first = stationAccesses[0] as AccessRow;
        const ads = (await database.query('SELECT * FROM app.list_client_viewer_ads($1)', [stationId])) as AdRow[];
        const figures = (await database.query('SELECT * FROM app.read_client_viewer_figures($1, NULL, 7)', [stationId])) as FiguresRow[];
        const slots = (await database.query('SELECT * FROM app.list_client_viewer_next_slots($1, NULL, 1)', [stationId])) as SlotRow[];
        const firstSlot = slots[0];
        const adTitles = new Map(ads.map((ad) => [ad.ad_id, ad.title]));
        stations.push({
          stationId,
          stationName: first.station_name,
          frequencyLabel: first.station_frequency_label,
          contact: { name: first.station_contact_name, phoneNumberE164: first.station_contact_phone_number_e164 },
          clients: stationAccesses.map((access) => ({ id: access.client_id, name: access.client_name })),
          nextOnAir: firstSlot ? { ...toSlot(firstSlot), adId: firstSlot.ad_id, adTitle: adTitles.get(firstSlot.ad_id) ?? '' } : null,
          lastSevenDays: sumFigures(figures),
          ads: ads.map((ad) => toAdSummary(ad, slots.find((slot) => slot.ad_id === ad.ad_id) ?? null)),
        });
      }
      return { stations };
    });
  }

  /** One advert, with its card, its next times on air and the station's contact; 404 for an advert the person may not view. */
  adDetail(stationId: string, adId: string): Promise<ClientAdDetail> {
    return this.asTheClient(async (database) => {
      const [ad] = (await database.query('SELECT * FROM app.read_client_viewer_ad($1, $2)', [stationId, adId])) as Array<AdRow & { action_card_content: ClientAdDetail['actionCard'] }>;
      if (!ad) throw new AppError('NOT_FOUND', { internalDetail: 'no advert this person may view' });
      const [heard] = (await database.query('SELECT * FROM app.read_client_viewer_figures($1, $2, 7)', [stationId, adId])) as FiguresRow[];
      const slots = (await database.query('SELECT * FROM app.list_client_viewer_next_slots($1, $2, $3)', [stationId, adId, NEXT_TIMES_ON_AIR_SHOWN])) as SlotRow[];
      const access = (await this.accesses(database)).find((row) => row.station_id === stationId);
      if (!access) throw new AppError('NOT_FOUND', { internalDetail: 'no access to this station' });
      return {
        ...toAdSummary({ ...ad, heard_last_seven_days: heard?.heard ?? 0 }, slots[0] ?? null),
        station: {
          id: stationId,
          name: access.station_name,
          frequencyLabel: access.station_frequency_label,
          contact: { name: access.station_contact_name, phoneNumberE164: access.station_contact_phone_number_e164 },
        },
        actionCard: ad.action_card_content,
        nextTimesOnAir: slots.map(toSlot),
      };
    });
  }

  /** Heard and taps by button type for one advert over today, 7 or 30 of the station's days. */
  adFigures(stationId: string, adId: string, query: ClientFiguresQuery): Promise<ClientAdFigures> {
    return this.asTheClient(async (database) => {
      const [row] = (await database.query('SELECT * FROM app.read_client_viewer_figures($1, $2, $3)', [
        stationId,
        adId,
        LISTENER_FIGURES_RANGE_DAYS[query.range],
      ])) as FiguresRow[];
      if (!row) throw new AppError('NOT_FOUND', { internalDetail: 'no advert this person may view' });
      return { range: query.range, firstDay: row.first_day, lastDay: row.last_day, ...toFigures(row) };
    });
  }

  /** Who is listening to one advert, under the small-group rule (ADR-005 decision 5). */
  adListenerMix(stationId: string, adId: string, query: ClientFiguresQuery): Promise<ListenerMix> {
    return this.asTheClient(async (database) => {
      const [row] = (await database.query('SELECT * FROM app.read_listener_mix_for_client_ad($1, $2, $3)', [
        stationId,
        adId,
        LISTENER_FIGURES_RANGE_DAYS[query.range],
      ])) as ListenerMixRow[];
      if (!row) throw new AppError('NOT_FOUND', { internalDetail: 'no advert this person may view' });
      return toListenerMix(query.range, row);
    });
  }

  /** One station's figures day by day, as a spreadsheet the person downloads (P5C-EXPORT-01). */
  spreadsheet(stationId: string, query: ClientSpreadsheetQuery): Promise<{ fileName: string; content: string }> {
    return this.asTheClient(async (database) => {
      const access = (await this.accesses(database)).find((row) => row.station_id === stationId);
      if (!access) throw new AppError('NOT_FOUND', { internalDetail: 'no access to this station' });
      const rows = (await database.query('SELECT * FROM app.list_client_viewer_daily_figures($1, $2)', [
        stationId,
        LISTENER_FIGURES_RANGE_DAYS[query.range],
      ])) as Array<{ station_day: string; title: string; heard: number; call_taps: number; whatsapp_taps: number; map_taps: number; link_taps: number }>;
      const [days] = (await database.query(`SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS last_day`, [
        access.station_time_zone,
      ])) as Array<{ last_day: string }>;
      return {
        fileName: spreadsheetFileName(access.station_name, days?.last_day ?? 'today'),
        content: clientSpreadsheet(
          rows.map((row) => ({
            stationDay: row.station_day,
            title: row.title,
            heard: row.heard,
            calls: row.call_taps,
            whatsApp: row.whatsapp_taps,
            directions: row.map_taps,
            website: row.link_taps,
          })),
        ),
      };
    });
  }

  /** The person's reminder settings, and every advert they follow for the per-advert switches. */
  notificationSettings(pushPublicKey: string | null): Promise<ClientNotificationSettings> {
    return this.asTheClient(async (database) => {
      const accesses = await this.accesses(database);
      if (accesses.length === 0) throw new AppError('NOT_FOUND', { internalDetail: 'not a client viewer' });
      const [settings] = (await database.query('SELECT * FROM app.read_client_viewer_notification_settings()')) as Array<{
        is_push_on: boolean;
        is_email_on: boolean;
        lead_minutes: number;
        muted_ads: Array<{ stationId: string; adId: string }>;
      }>;
      const ads: ClientNotificationSettings['ads'] = [];
      for (const stationId of [...new Set(accesses.map((access) => access.station_id))]) {
        const stationName = accesses.find((access) => access.station_id === stationId)?.station_name ?? null;
        for (const ad of (await database.query('SELECT ad_id, title FROM app.list_client_viewer_ads($1)', [stationId])) as Array<{ ad_id: string; title: string }>) {
          ads.push({ stationId, stationName, adId: ad.ad_id, title: ad.title });
        }
      }
      return {
        isPushOn: settings?.is_push_on ?? true,
        isEmailOn: settings?.is_email_on ?? false,
        leadMinutes: (settings?.lead_minutes ?? 15) as ClientNotificationSettings['leadMinutes'],
        mutedAds: settings?.muted_ads ?? [],
        isPushAvailable: pushPublicKey !== null,
        pushPublicKey,
        ads,
      };
    });
  }

  async saveNotificationSettings(input: ClientNotificationSettingsInput, pushPublicKey: string | null): Promise<ClientNotificationSettings> {
    const [row] = (await this.asTheClient((database) =>
      database.query('SELECT app.save_client_viewer_notification_settings($1, $2, $3, $4::jsonb) AS outcome', [
        input.isPushOn,
        input.isEmailOn,
        input.leadMinutes,
        JSON.stringify(input.mutedAds),
      ]),
    )) as Array<{ outcome: string }>;
    if (row?.outcome !== 'SAVED') throw new AppError('NOT_FOUND', { internalDetail: `settings not saved: ${row?.outcome}` });
    return this.notificationSettings(pushPublicKey);
  }

  /** Whether the signed-in person may view anything at this station (the guard's question). */
  canViewStation(stationId: string): Promise<boolean> {
    return this.asTheClient(async (database) => (await this.accesses(database)).some((access) => access.station_id === stationId));
  }

  /** A transaction as the signed-in person, with no station: the client functions answer, station rules show nothing. */
  asTheClient<Result>(work: (database: EntityManager) => Promise<Result>): Promise<Result> {
    return this.stationScopedTransaction.run(work, { userId: this.requestContext.get<string>('userId'), stationId: '' });
  }

  private accesses(database: EntityManager): Promise<AccessRow[]> {
    return database.query('SELECT * FROM app.list_client_viewer_accesses()') as Promise<AccessRow[]>;
  }
}

function toSlot(row: SlotRow): ClientSlot {
  return {
    startsAt: row.slot_starts_at.toISOString(),
    endsAt: row.slot_ends_at.toISOString(),
    localDate: row.local_date,
    localStartTime: row.local_start_time,
    localEndTime: row.local_end_time,
  };
}

function toFigures(row: Pick<FiguresRow, 'heard' | 'call_taps' | 'whatsapp_taps' | 'map_taps' | 'link_taps'>): ClientFigures {
  return { heard: row.heard, calls: row.call_taps, whatsApp: row.whatsapp_taps, directions: row.map_taps, website: row.link_taps };
}

/** One station's figures over its adverts: added within the station only, never across stations. */
function sumFigures(rows: readonly FiguresRow[]): ClientFigures {
  return rows.reduce<ClientFigures>(
    (total, row) => {
      const figures = toFigures(row);
      return {
        heard: total.heard + figures.heard,
        calls: total.calls + figures.calls,
        whatsApp: total.whatsApp + figures.whatsApp,
        directions: total.directions + figures.directions,
        website: total.website + figures.website,
      };
    },
    { heard: 0, calls: 0, whatsApp: 0, directions: 0, website: 0 },
  );
}

function toAdSummary(ad: AdRow, nextSlot: SlotRow | null): ClientAdSummary {
  return {
    id: ad.ad_id,
    title: ad.title,
    clientId: ad.client_id,
    clientName: ad.client_name,
    status: ad.campaign_display_status,
    startsOn: ad.campaign_starts_on,
    endsOn: ad.campaign_ends_on,
    timeWindows: ad.campaign_time_windows ?? [],
    heardLastSevenDays: ad.heard_last_seven_days ?? 0,
    nextOnAir: nextSlot ? toSlot(nextSlot) : null,
  };
}
