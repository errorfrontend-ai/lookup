import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { type ListenerStation, ListenerStationList, MAXIMUM_LISTED_STATIONS } from '@lookup/contracts';
import type { Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { LISTENER_INSTALL_ID } from '../../common/listener-authentication/install-token.guard.js';
import type { RateLimitRule } from '../../common/rate-limiting/rate-limit-rule.js';
import { RateLimiter } from '../../common/rate-limiting/rate-limiter.js';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { StationScopedTransaction } from '../../infrastructure/database/station-scoped-transaction.js';

/** One row of recognition.list_stations_for_listeners. */
interface ListedStationRow {
  station_id: string;
  station_name: string;
  station_frequency_label: string;
  station_city: string | null;
}

/** A strong ETag for an answer: the first 27 characters of the base64url SHA-256 of its body, in quotes (P4 design §5.6). */
export function strongEntityTagOf(body: string): string {
  return `"${createHash('sha256').update(body, 'utf8').digest('base64url').slice(0, 27)}"`;
}

/**
 * Whether an If-None-Match header lists this ETag, exactly (any of its comma-separated tags). The app sends back the
 * strong tag it was given; a weak `W/"…"` or `*` is not that tag, so it gets the list.
 */
export function isListedInIfNoneMatch(ifNoneMatch: string | undefined, entityTag: string): boolean {
  return (ifNoneMatch ?? '').split(',').some((listedTag) => listedTag.trim() === entityTag);
}

/**
 * The stations a listener may pick as "My station" (P4 design §5.6, P4-D17): ACTIVE and listed in the app, by name,
 * at most 1,000, read through a definer function that returns only public facts. The answer is checked against the
 * shared contract before it leaves, and its ETag is the hash of exactly the body that is sent.
 */
@Injectable()
export class ListenerStationsService {
  private readonly requestsPerInstall: RateLimitRule;

  constructor(
    private readonly stationScopedTransaction: StationScopedTransaction,
    private readonly rateLimiter: RateLimiter,
    private readonly requestContext: ClsService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.requestsPerInstall = {
      counterName: 'station-list-requests-per-install-hour',
      maximumRequests: config.STATION_LIST_REQUESTS_PER_INSTALL_PER_HOUR,
      windowSeconds: 60 * 60,
    };
  }

  /** Per install, after the install token (the app asks again only after 24 hours, so this is generous). */
  async countAgainstLimit(response: Response): Promise<void> {
    await this.rateLimiter.countRequest(this.requestsPerInstall, this.requestContext.get<string>(LISTENER_INSTALL_ID), response);
  }

  /** The answer and its ETag. Express writes it with JSON.stringify and no replacer or spacing, so the ETag is the hash of the body, byte for byte. */
  async readStationList(): Promise<{ stationList: ListenerStationList; entityTag: string }> {
    const stationList = ListenerStationList.parse({ stations: await this.readListedStations() });
    return { stationList, entityTag: strongEntityTagOf(JSON.stringify(stationList)) };
  }

  /** The listed stations, in the database's order. Logos stay null until stations can upload them (S3-D21), as in a recognition's answer. */
  async readListedStations(): Promise<ListenerStation[]> {
    const rows = (await this.stationScopedTransaction.run((database) =>
      database.query('SELECT * FROM recognition.list_stations_for_listeners($1)', [MAXIMUM_LISTED_STATIONS]),
    )) as ListedStationRow[];
    return rows.map((row) => ({ id: row.station_id, name: row.station_name, frequency_label: row.station_frequency_label, city: row.station_city, logo: null }));
  }
}
