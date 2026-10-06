import { z } from 'zod';

/** The tabs of the ads list. PAUSED ads appear only under "all" (pausing arrives with Step 3). */
export const AD_LIST_VIEWS = ['all', 'live', 'scheduled', 'drafts', 'attention', 'ended'] as const;
export type AdListView = (typeof AD_LIST_VIEWS)[number];

/** How the list is ordered: last changed first, newest start date first (unscheduled last), or A to Z. */
export const AD_LIST_SORTS = ['updated', 'startDate', 'title'] as const;
export type AdListSort = (typeof AD_LIST_SORTS)[number];

export const MAXIMUM_AD_SEARCH_LENGTH = 80;
export const ADS_PER_PAGE = 20;

/** GET /stations/{stationId}/ads?view&clientId&search&sort&cursor */
export const AdListQuery = z.strictObject({
  view: z.enum(AD_LIST_VIEWS).default('all'),
  clientId: z.uuid().optional(),
  /** Matches the ad's title or its client's name, ignoring capitals. */
  search: z.string().trim().min(1).max(MAXIMUM_AD_SEARCH_LENGTH).optional(),
  sort: z.enum(AD_LIST_SORTS).default('updated'),
  /** The `nextCursor` of the previous page, for the same view, client, search and sort. */
  cursor: z.string().min(1).max(1000).optional(),
});
export type AdListQuery = z.infer<typeof AdListQuery>;

/** How many ads fall under each tab, for the whole station. */
export type AdListViewCounts = Record<AdListView, number>;
