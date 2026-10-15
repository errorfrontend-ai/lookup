import { LISTENER_FIGURES_RANGE_DAYS, type ListenerFigures, type ListenerFiguresQuery } from '@lookup/contracts';
import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error.js';
import { StationScopedTransaction } from '../../infrastructure/database/station-scoped-transaction.js';
import { COUNTED_RECOGNITION_OUTCOMES } from '../ads/ad-records.js';

interface ListenerFiguresRow {
  first_day: string;
  last_day: string;
  recognitions_today: number;
  recognitions: number;
  recognitions_sent_later: number;
  button_taps: number;
  recognitions_by_hour: number[];
}

/**
 * The station's listener figures over its last 1, 7 or 30 days (P5B-OVERVIEW-04 to -16), counted from the
 * recognitions and taps themselves through row-level security, so a station only ever counts its own (P5B-D2).
 * Recognitions count on the station's day and hour they were heard; taps on the day they were made.
 */
@Injectable()
export class ListenerFiguresService {
  constructor(private readonly stationScopedTransaction: StationScopedTransaction) {}

  read(query: ListenerFiguresQuery): Promise<ListenerFigures> {
    return this.stationScopedTransaction.run(async (database) => {
      const [row] = (await database.query(
        `WITH period AS (
           SELECT station.time_zone,
                  (((now() AT TIME ZONE station.time_zone)::date - ($1::integer - 1))::timestamp AT TIME ZONE station.time_zone) AS started_at,
                  ((now() AT TIME ZONE station.time_zone)::date::timestamp AT TIME ZONE station.time_zone) AS today_started_at,
                  to_char((now() AT TIME ZONE station.time_zone)::date - ($1::integer - 1), 'YYYY-MM-DD') AS first_day,
                  to_char((now() AT TIME ZONE station.time_zone)::date, 'YYYY-MM-DD') AS last_day
             FROM app.stations AS station
            WHERE station.id = app.current_station_id()
         ),
         heard AS MATERIALIZED (
           SELECT heard_event.captured_at, heard_event.is_deferred
             FROM app.recognition_events AS heard_event
            WHERE heard_event.station_id = app.current_station_id()
              AND heard_event.outcome IN ${COUNTED_RECOGNITION_OUTCOMES}
              AND heard_event.captured_at >= (SELECT started_at FROM period)
              -- A clip arrives at most 24 hours after it was heard and never 2 minutes before: this bounds the months read.
              AND heard_event.received_at >= (SELECT started_at FROM period) - interval '2 minutes'
         )
         SELECT period.first_day, period.last_day,
                (SELECT count(*) FROM heard WHERE heard.captured_at >= period.today_started_at)::integer AS recognitions_today,
                (SELECT count(*) FROM heard)::integer AS recognitions,
                (SELECT count(*) FROM heard WHERE heard.is_deferred)::integer AS recognitions_sent_later,
                (SELECT count(*) FROM app.engagement_events AS tap
                  WHERE tap.station_id = app.current_station_id()
                    AND tap.occurred_at >= period.started_at AND tap.received_at >= period.started_at)::integer AS button_taps,
                ARRAY(SELECT coalesce(by_hour.recognition_count, 0)
                        FROM generate_series(0, 23) AS hour_of_day
                        LEFT JOIN (SELECT extract(hour FROM heard.captured_at AT TIME ZONE period.time_zone)::integer AS heard_hour,
                                          count(*)::integer AS recognition_count
                                     FROM heard GROUP BY 1) AS by_hour ON by_hour.heard_hour = hour_of_day
                       ORDER BY hour_of_day) AS recognitions_by_hour
           FROM period`,
        [LISTENER_FIGURES_RANGE_DAYS[query.range]],
      )) as ListenerFiguresRow[];
      if (!row) throw new AppError('INTERNAL', { internalDetail: 'listener figures read with no current station row' });
      return {
        range: query.range,
        firstDay: row.first_day,
        lastDay: row.last_day,
        recognitionsToday: row.recognitions_today,
        recognitions: row.recognitions,
        recognitionsSentLater: row.recognitions_sent_later,
        buttonTaps: row.button_taps,
        recognitionsByHour: row.recognitions_by_hour,
      };
    });
  }
}
