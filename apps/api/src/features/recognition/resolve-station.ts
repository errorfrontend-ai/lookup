import { type ActionCard, MAXIMUM_CHOOSER_CANDIDATES } from '@lookup/contracts';

/**
 * One row of recognition.find_station_candidates: one campaign that makes its station an owner of the matched
 * recording. The moment the clip was heard decided the window, the period and the slots; the moment it is
 * processed decided the statuses, the card versions and whether the tap limit is reached (P4-D5).
 */
export interface StationCandidateRow {
  station_id: string;
  station_name: string;
  station_frequency_label: string;
  station_city: string | null;
  ad_title: string;
  client_name: string;
  campaign_id: string;
  /** The start of the campaign's period (the lower bound of its active period). */
  campaign_period_started_at: Date | null;
  /** ACTIVE now; false for a campaign paused or ended after the clip was heard (O13). */
  is_campaign_active: boolean;
  campaign_action_card_id: string | null;
  campaign_card: ActionCard | null;
  client_default_action_card_id: string | null;
  client_default_card: ActionCard | null;
  /** On air when the clip was heard: inside the period and one of its slots, grace included. */
  is_in_window: boolean;
  /** The start of the latest slot the clip falls in (only when on air). */
  matched_slot_started_at: Date | null;
  /** The end of the slot that ended last before the clip was heard, within 7 days. */
  last_slot_ended_at: Date | null;
  is_at_engagement_limit: boolean;
}

export type CardKind = 'CAMPAIGN' | 'CLIENT_DEFAULT';
export type StationResolutionName = 'SINGLE_OWNER' | 'SCHEDULE_UNIQUE' | 'HINT' | 'UNRESOLVED';

/** Why a station shows its client's usual card instead of the campaign's own. */
export type DefaultCardReason = 'not_on_air' | 'campaign_not_active' | 'campaign_at_tap_limit' | 'campaign_has_no_card';
/** Why no station answered: none owns the recording, or none of its owners has a card to show. */
export type NoMatchReason = 'no_station_airs_it' | 'no_card_to_show';
/** One station answers, and other stations own the recording but have no card to show (gap 27). */
export const OTHER_OWNERS_HAVE_NO_CARD = 'other_owners_have_no_card';

/** A station that can answer: its one campaign on the recording, and the card it would show. */
export interface StationCandidate {
  stationId: string;
  stationName: string;
  frequencyLabel: string;
  city: string | null;
  clientName: string;
  adTitle: string;
  campaignId: string;
  cardKind: CardKind;
  actionCardId: string;
  card: ActionCard;
  isInWindow: boolean;
  matchedSlotStartedAt: Date | null;
  lastSlotEndedAt: Date | null;
  /** Set when the card is the client's usual one. */
  defaultCardReason: DefaultCardReason | null;
}

/** A station weighed for the recognition, as recognition.finish_recognition stores it (one candidate row). */
export interface WeighedCandidate {
  station_id: string;
  campaign_id: string;
  action_card_id: string;
  card_kind: CardKind;
  is_in_window: boolean;
  /** 1 to 4 for a station a chooser shows, in display order; null when weighed but not shown. */
  display_position: number | null;
}

export type StationResolution =
  | { outcome: 'NO_MATCH'; resolution: null; fallbackReason: NoMatchReason; weighedCandidates: WeighedCandidate[] }
  | {
      outcome: 'MATCH' | 'MATCH_DEFAULT';
      resolution: Exclude<StationResolutionName, 'UNRESOLVED'>;
      fallbackReason: DefaultCardReason | typeof OTHER_OWNERS_HAVE_NO_CARD | null;
      matched: StationCandidate;
      weighedCandidates: WeighedCandidate[];
    }
  | { outcome: 'CHOOSE_STATION'; resolution: 'UNRESOLVED'; fallbackReason: null; shownCandidates: StationCandidate[]; weighedCandidates: WeighedCandidate[] };

const timeOf = (moment: Date | null): number | null => (moment === null ? null : moment.getTime());

/** Later first; a moment that exists before one that does not. */
function compareLaterFirst(first: Date | null, second: Date | null): number {
  const firstTime = timeOf(first);
  const secondTime = timeOf(second);
  if (firstTime === secondTime) return 0;
  if (firstTime === null) return 1;
  if (secondTime === null) return -1;
  return secondTime - firstTime;
}

/** Plain code-unit order, the same on every machine (never the locale's). */
function compareText(first: string, second: string): number {
  if (first === second) return 0;
  return first < second ? -1 : 1;
}

/**
 * Which of a station's campaigns on the recording speaks for it (P4 design §5.1, step 1; P4-TIMERULE-09), each
 * rule breaking the ties of the one before: on air, the slot that started last; else the slot that ended last
 * within 7 days; else the latest period that had started when the clip was heard; else, all starting later, the
 * first to start; then the campaign id. So a campaign that had not started never stands in for one that was on air.
 */
function compareCampaignsOfOneStation(first: StationCandidateRow, second: StationCandidateRow, capturedAt: Date): number {
  if (first.is_in_window !== second.is_in_window) return first.is_in_window ? -1 : 1;
  const bySlotStart = first.is_in_window ? compareLaterFirst(first.matched_slot_started_at, second.matched_slot_started_at) : 0;
  if (bySlotStart !== 0) return bySlotStart;
  const bySlotEnd = compareLaterFirst(first.last_slot_ended_at, second.last_slot_ended_at);
  if (bySlotEnd !== 0) return bySlotEnd;
  const hasStarted = (row: StationCandidateRow) => (timeOf(row.campaign_period_started_at) ?? Number.NEGATIVE_INFINITY) <= capturedAt.getTime();
  if (hasStarted(first) !== hasStarted(second)) return hasStarted(first) ? -1 : 1;
  const firstStart = timeOf(first.campaign_period_started_at) ?? Number.NEGATIVE_INFINITY;
  const secondStart = timeOf(second.campaign_period_started_at) ?? Number.NEGATIVE_INFINITY;
  if (firstStart !== secondStart) return hasStarted(first) ? (secondStart > firstStart ? 1 : -1) : firstStart < secondStart ? -1 : 1;
  return compareText(first.campaign_id, second.campaign_id);
}

/**
 * The card a station shows (§5.1, step 2): the campaign's own while it is on air, ACTIVE, below its tap limit and
 * has one; otherwise the client's usual card; otherwise none, and the station is not offered at all (gap 25).
 * Limits and the processing-time status decide only which card a station shows, never which station answers.
 */
function cardOfStation(campaign: StationCandidateRow): StationCandidate | null {
  const shared = {
    stationId: campaign.station_id,
    stationName: campaign.station_name,
    frequencyLabel: campaign.station_frequency_label,
    city: campaign.station_city,
    clientName: campaign.client_name,
    adTitle: campaign.ad_title,
    campaignId: campaign.campaign_id,
    isInWindow: campaign.is_in_window,
    matchedSlotStartedAt: campaign.matched_slot_started_at,
    lastSlotEndedAt: campaign.last_slot_ended_at,
  };
  const hasCampaignCard = campaign.campaign_card !== null && campaign.campaign_action_card_id !== null;
  if (campaign.is_in_window && campaign.is_campaign_active && !campaign.is_at_engagement_limit && hasCampaignCard) {
    return { ...shared, cardKind: 'CAMPAIGN', actionCardId: campaign.campaign_action_card_id as string, card: campaign.campaign_card as ActionCard, defaultCardReason: null };
  }
  if (campaign.client_default_card === null || campaign.client_default_action_card_id === null) return null;
  const defaultCardReason: DefaultCardReason = !campaign.is_in_window
    ? 'not_on_air'
    : !campaign.is_campaign_active
      ? 'campaign_not_active'
      : campaign.is_at_engagement_limit
        ? 'campaign_at_tap_limit'
        : 'campaign_has_no_card';
  return { ...shared, cardKind: 'CLIENT_DEFAULT', actionCardId: campaign.client_default_action_card_id, card: campaign.client_default_card, defaultCardReason };
}

/** On air: the slot that started last first. None on air: the slot that ended last first (none: last). Then name, then id. */
function compareForChooser(first: StationCandidate, second: StationCandidate): number {
  const byTime = first.isInWindow
    ? compareLaterFirst(first.matchedSlotStartedAt, second.matchedSlotStartedAt)
    : compareLaterFirst(first.lastSlotEndedAt, second.lastSlotEndedAt);
  if (byTime !== 0) return byTime;
  const byName = compareText(first.stationName.toLowerCase(), second.stationName.toLowerCase());
  return byName !== 0 ? byName : compareText(first.stationId, second.stationId);
}

function toWeighedCandidate(candidate: StationCandidate, displayPosition: number | null): WeighedCandidate {
  return {
    station_id: candidate.stationId,
    campaign_id: candidate.campaignId,
    action_card_id: candidate.actionCardId,
    card_kind: candidate.cardKind,
    is_in_window: candidate.isInWindow,
    display_position: displayPosition,
  };
}

/**
 * Whose buttons a matched recording gets (P4 design §5.1; ADR-003), from the rows of
 * recognition.find_station_candidates, in the plan's order: candidates, then the schedule, then the listener's
 * hint, then limits (which only change a station's card). With S the stations that can show a card and W those of
 * them on air:
 *
 * - S empty: NO_MATCH (no owner, or no owner with a card).
 * - one station in S: MATCH with its card, SINGLE_OWNER.
 * - several in S, exactly one in W: MATCH, SCHEDULE_UNIQUE.
 * - several in W, the hint among them: MATCH with the hinted station's card, HINT.
 * - several in W, no usable hint: CHOOSE_STATION of the first 4 of W, UNRESOLVED.
 * - W empty, the hint in S: MATCH with the hinted station's usual card, HINT.
 * - W empty, several in S, no usable hint: CHOOSE_STATION of usual cards, UNRESOLVED.
 *
 * The server never guesses between stations on air. A hint is used only when it names a station of W, or of S
 * when none is on air, listed in the app or not (Correction 3); any other hint is ignored. Every station of S is
 * weighed (one candidate row each, whatever the outcome, P4-D8); only the stations a chooser shows get a place.
 */
export function resolveStation(rows: readonly StationCandidateRow[], options: { capturedAt: Date; stationHint: string | null }): StationResolution {
  const campaignsByStation = new Map<string, StationCandidateRow[]>();
  for (const row of rows) campaignsByStation.set(row.station_id, [...(campaignsByStation.get(row.station_id) ?? []), row]);

  const withCard: StationCandidate[] = [];
  for (const campaigns of campaignsByStation.values()) {
    const [speaksForStation] = [...campaigns].sort((first, second) => compareCampaignsOfOneStation(first, second, options.capturedAt));
    const candidate = cardOfStation(speaksForStation as StationCandidateRow);
    if (candidate) withCard.push(candidate);
  }
  // A stable order for the stored rows, whatever order the stations arrived in.
  withCard.sort((first, second) => compareText(first.stationId, second.stationId));

  if (withCard.length === 0) {
    return { outcome: 'NO_MATCH', resolution: null, fallbackReason: campaignsByStation.size === 0 ? 'no_station_airs_it' : 'no_card_to_show', weighedCandidates: [] };
  }

  const onAir = withCard.filter((candidate) => candidate.isInWindow);
  const hint = options.stationHint?.toLowerCase() ?? null;
  const match = (matched: StationCandidate, resolution: Exclude<StationResolutionName, 'UNRESOLVED'>): StationResolution => ({
    outcome: matched.cardKind === 'CAMPAIGN' ? 'MATCH' : 'MATCH_DEFAULT',
    resolution,
    fallbackReason: resolution === 'SINGLE_OWNER' && campaignsByStation.size > 1 ? OTHER_OWNERS_HAVE_NO_CARD : matched.defaultCardReason,
    matched,
    weighedCandidates: withCard.map((candidate) => toWeighedCandidate(candidate, null)),
  });

  if (withCard.length === 1) return match(withCard[0] as StationCandidate, 'SINGLE_OWNER');
  if (onAir.length === 1) return match(onAir[0] as StationCandidate, 'SCHEDULE_UNIQUE');

  // Several on air: only they can be meant. None on air: any station that can show a card.
  const meant = onAir.length > 1 ? onAir : withCard;
  const hinted = hint === null ? undefined : meant.find((candidate) => candidate.stationId.toLowerCase() === hint);
  if (hinted) return match(hinted, 'HINT');

  const shownCandidates = [...meant].sort(compareForChooser).slice(0, MAXIMUM_CHOOSER_CANDIDATES);
  const positions = new Map(shownCandidates.map((candidate, index) => [candidate.stationId, index + 1]));
  return {
    outcome: 'CHOOSE_STATION',
    resolution: 'UNRESOLVED',
    fallbackReason: null,
    shownCandidates,
    weighedCandidates: withCard.map((candidate) => toWeighedCandidate(candidate, positions.get(candidate.stationId) ?? null)),
  };
}
