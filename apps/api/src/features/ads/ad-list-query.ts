import { ADS_PER_PAGE, AD_LIST_VIEWS, type AdListQuery, type AdListSort, type AdListView, type AdListViewCounts } from '@lookup/contracts';
import { AppError } from '../../common/errors/app-error.js';
import { AD_RECORD_SELECT, type AdRecord } from './ad-records.js';

/** What makes an ad belong under each tab, written against the columns of AD_RECORD_SELECT. */
export const AD_LIST_VIEW_CONDITIONS: Record<AdListView, string> = {
  all: 'TRUE',
  live: `listed.campaign_display_status = 'LIVE_NOW'`,
  scheduled: `listed.campaign_display_status = 'SCHEDULED'`,
  drafts: `(listed.campaign_display_status IS NULL OR listed.campaign_display_status = 'DRAFT')`,
  attention: `(listed.is_upload_refused OR listed.is_needing_review OR listed.is_upload_not_finished
               OR listed.is_start_date_passed OR listed.is_ending_soon)`,
  ended: `listed.campaign_display_status = 'ENDED'`,
};

/**
 * The station's ads (archived ones never), with each ad's display status worked out once.
 * MATERIALIZED stops Postgres from evaluating it again for every condition that reads it.
 */
export const LISTED_ADS_CTE = `
  WITH listed AS MATERIALIZED (
    ${AD_RECORD_SELECT}
     WHERE ads.station_id = app.current_station_id() AND ads.archived_at IS NULL
  )`;

/** One counting column per tab (`all_count`, `live_count`, …), for a query over `listed`. */
export const AD_LIST_VIEW_COUNT_COLUMNS = AD_LIST_VIEWS.map(
  (view) => `count(*) FILTER (WHERE ${AD_LIST_VIEW_CONDITIONS[view]})::integer AS ${view}_count`,
).join(',\n         ');

export function toAdListViewCounts(row: Record<string, number>): AdListViewCounts {
  return Object.fromEntries(AD_LIST_VIEWS.map((view) => [view, row[`${view}_count`] ?? 0])) as AdListViewCounts;
}

/** Most serious problem first (the order of AD_ATTENTION_REASONS), for sorting the attention list. */
export const ATTENTION_SEVERITY_ORDER = `CASE WHEN listed.is_upload_refused THEN 0 WHEN listed.is_needing_review THEN 1
                                              WHEN listed.is_upload_not_finished THEN 2 WHEN listed.is_start_date_passed THEN 3 ELSE 4 END`;

const TIMESTAMP_TEXT = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

/** The value a page's last ad had for the sort, which the next page continues after. */
const SORT_KEY_COLUMNS: Record<AdListSort, string> = {
  updated: `to_char(listed.last_changed_at AT TIME ZONE 'UTC', ${TIMESTAMP_TEXT})`,
  title: 'lower(listed.title)',
  startDate: `coalesce(to_char(listed.campaign_starts_at AT TIME ZONE 'UTC', ${TIMESTAMP_TEXT}), '-infinity')`,
};

const ORDER_BY: Record<AdListSort, string> = {
  updated: 'listed.last_changed_at DESC, listed.id DESC',
  title: 'lower(listed.title), listed.id',
  startDate: `coalesce(listed.campaign_starts_at, '-infinity'::timestamptz) DESC, listed.id DESC`,
};

/** Keyset paging: continue strictly after the last ad of the previous page, in the same order. */
const AFTER_CURSOR: Record<AdListSort, string> = {
  updated: '($3::text IS NULL OR (listed.last_changed_at, listed.id) < ($3::text::timestamptz, $4::uuid))',
  title: '($3::text IS NULL OR (lower(listed.title), listed.id) > ($3::text, $4::uuid))',
  startDate: `($3::text IS NULL OR (coalesce(listed.campaign_starts_at, '-infinity'::timestamptz), listed.id) < ($3::text::timestamptz, $4::uuid))`,
};

const TIMESTAMP_KEY = /^(-infinity|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)$/;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAXIMUM_TITLE_KEY_LENGTH = 200;

/** Makes `%`, `_` and `\` in what a person typed match themselves instead of acting as wildcards. */
export function escapeLikePattern(typedText: string): string {
  return typedText.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export interface AdListRow extends AdRecord {
  sort_key_text: string;
}

export function buildAdListQuery(query: AdListQuery): { sql: string; parameters: unknown[] } {
  const cursor = query.cursor === undefined ? null : readAdListCursor(query.sort, query.cursor);
  const sql = `${LISTED_ADS_CTE}
    SELECT listed.*, ${SORT_KEY_COLUMNS[query.sort]} AS sort_key_text
      FROM listed
     WHERE ${AD_LIST_VIEW_CONDITIONS[query.view]}
       AND ($1::uuid IS NULL OR listed.client_id = $1::uuid)
       AND ($2::text IS NULL
            OR listed.title ILIKE '%' || $2::text || '%' ESCAPE '\\'
            OR listed.client_name ILIKE '%' || $2::text || '%' ESCAPE '\\')
       AND ${AFTER_CURSOR[query.sort]}
     ORDER BY ${ORDER_BY[query.sort]}
     LIMIT ${ADS_PER_PAGE + 1}`;
  const parameters = [
    query.clientId ?? null,
    query.search === undefined ? null : escapeLikePattern(query.search),
    cursor?.sortKey ?? null,
    cursor?.adId ?? null,
  ];
  return { sql, parameters };
}

/** The cursor for the page after this one, or null on the last page. */
export function nextAdListCursor(sort: AdListSort, rows: AdListRow[]): string | null {
  const lastRow = rows[ADS_PER_PAGE - 1];
  if (rows.length <= ADS_PER_PAGE || !lastRow) return null;
  return Buffer.from(JSON.stringify([sort, lastRow.sort_key_text, lastRow.id])).toString('base64url');
}

function readAdListCursor(sort: AdListSort, cursor: string): { sortKey: string; adId: string } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && parsed.length === 3) {
      const [cursorSort, sortKey, adId] = parsed as unknown[];
      const keyIsValid =
        typeof sortKey === 'string' &&
        (sort === 'title' ? sortKey.length <= MAXIMUM_TITLE_KEY_LENGTH : TIMESTAMP_KEY.test(sortKey));
      // A cursor only continues the same ordering it came from.
      if (cursorSort === sort && keyIsValid && typeof adId === 'string' && ID_PATTERN.test(adId)) {
        return { sortKey, adId };
      }
    }
  } catch {
    // Falls through to the refusal below.
  }
  throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'cursor', code: 'invalid_cursor' }], internalDetail: 'malformed list cursor' });
}
