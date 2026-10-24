import { LISTENER_AGE_BANDS, LISTENER_FIGURES_RANGE_DAYS, LISTENER_GENDERS, type ListenerMix, type ListenerMixQuery } from '@lookup/contracts';
import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error.js';
import { StationScopedTransaction } from '../../infrastructure/database/station-scoped-transaction.js';
import { suppressSmallGroups } from './listener-mix-suppression.js';

/** What the database functions return: counts only, every group present, with a zero where nobody is. */
export interface ListenerMixRow {
  first_day: string;
  last_day: string;
  known_listeners: number;
  not_known_yet_listeners: number;
  genders: Record<string, number>;
  age_bands: Record<string, number>;
}

/**
 * Who is listening to the station's ads (ADR-005, docs/design/listener-accounts.md §7; LA-STATS-01 to -06). The counts
 * come from database functions that read only the current station's recognitions and return counts and nothing else; the
 * small-group rule is applied here, by one pure function, so what leaves this class is what a station may see: no
 * breakdown below 10 known listeners, and groups under 10 folded together.
 */
@Injectable()
export class ListenerMixService {
  constructor(private readonly stationScopedTransaction: StationScopedTransaction) {}

  readForStation(query: ListenerMixQuery): Promise<ListenerMix> {
    return this.stationScopedTransaction.run(async (database) => {
      const [row] = (await database.query('SELECT * FROM app.read_listener_mix_for_station($1)', [LISTENER_FIGURES_RANGE_DAYS[query.range]])) as ListenerMixRow[];
      if (!row) throw new AppError('INTERNAL', { internalDetail: 'listener mix read with no current station row' });
      return this.shown(query, row);
    });
  }

  /** The same for one of the station's ads; another station's ad, and an id that is no ad, answer 404 like any other read. */
  readForAd(adId: string, query: ListenerMixQuery): Promise<ListenerMix> {
    return this.stationScopedTransaction.run(async (database) => {
      const [row] = (await database.query('SELECT * FROM app.read_listener_mix_for_ad($1, $2)', [adId, LISTENER_FIGURES_RANGE_DAYS[query.range]])) as ListenerMixRow[];
      if (!row) throw new AppError('NOT_FOUND', { internalDetail: 'no such ad for the listener mix' });
      return this.shown(query, row);
    });
  }

  private shown(query: ListenerMixQuery, row: ListenerMixRow): ListenerMix {
    return toListenerMix(query.range, row);
  }
}

/**
 * What a reader may see of one mix row (the station's, or a client's for one advert, ADR-006): the counts, and each
 * breakdown under the small-group rule.
 */
export function toListenerMix(range: ListenerMix['range'], row: ListenerMixRow): ListenerMix {
  return {
    range,
    firstDay: row.first_day,
    lastDay: row.last_day,
    listeners: row.known_listeners + row.not_known_yet_listeners,
    knownListeners: row.known_listeners,
    notKnownYetListeners: row.not_known_yet_listeners,
    genders: suppressSmallGroups(
      LISTENER_GENDERS.map((group) => ({ group, listeners: Number(row.genders[group] ?? 0) })),
      row.known_listeners,
    ),
    ageBands: suppressSmallGroups(
      LISTENER_AGE_BANDS.map((group) => ({ group, listeners: Number(row.age_bands[group] ?? 0) })),
      row.known_listeners,
    ),
  };
}
