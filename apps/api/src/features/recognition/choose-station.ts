import type { ActionCard } from '@lookup/contracts';

/** One row from recognition.find_stations_for_audio: a station that owns the matched recording. */
export interface StationCandidate {
  station_id: string;
  station_name: string;
  station_frequency_label: string;
  ad_title: string;
  client_name: string;
  campaign_id: string;
  campaign_action_card_id: string | null;
  campaign_card: ActionCard | null;
  client_default_action_card_id: string | null;
  client_default_card: ActionCard | null;
  is_in_window: boolean;
}

export type StationChoice =
  | { outcome: 'MATCH'; kind: 'CAMPAIGN'; candidate: StationCandidate; actionCardId: string; card: ActionCard }
  | { outcome: 'MATCH_DEFAULT'; kind: 'CLIENT_DEFAULT'; candidate: StationCandidate; actionCardId: string; card: ActionCard }
  | { outcome: 'NO_MATCH'; fallbackReason: 'no_station_airs_it' | 'not_on_air_and_no_default_card' | 'several_stations'; candidate?: StationCandidate };

/**
 * Whose buttons a matched recording gets, Step 3's rules (S3-D19). The candidates arrive newest
 * campaign first.
 * - Exactly one station has it on air at the capture moment: that campaign's card.
 * - None has it on air, and exactly one station owns it: that client's default card, or no match.
 * - Several stations (on air, or owning it when none is): no match until P4 adds the chooser.
 */
export function chooseStation(candidates: StationCandidate[]): StationChoice {
  const stationIds = (rows: StationCandidate[]) => new Set(rows.map((row) => row.station_id));
  const onAir = candidates.filter((candidate) => candidate.is_in_window && candidate.campaign_card && candidate.campaign_action_card_id);

  if (stationIds(onAir).size > 1) return { outcome: 'NO_MATCH', fallbackReason: 'several_stations' };
  const onAirCandidate = onAir[0];
  if (onAirCandidate) {
    return {
      outcome: 'MATCH',
      kind: 'CAMPAIGN',
      candidate: onAirCandidate,
      actionCardId: onAirCandidate.campaign_action_card_id as string,
      card: onAirCandidate.campaign_card as ActionCard,
    };
  }

  const owners = stationIds(candidates);
  if (owners.size === 0) return { outcome: 'NO_MATCH', fallbackReason: 'no_station_airs_it' };
  if (owners.size > 1) return { outcome: 'NO_MATCH', fallbackReason: 'several_stations' };
  const owner = candidates.find((candidate) => candidate.client_default_card && candidate.client_default_action_card_id);
  if (!owner) return { outcome: 'NO_MATCH', fallbackReason: 'not_on_air_and_no_default_card', candidate: candidates[0] };
  return {
    outcome: 'MATCH_DEFAULT',
    kind: 'CLIENT_DEFAULT',
    candidate: owner,
    actionCardId: owner.client_default_action_card_id as string,
    card: owner.client_default_card as ActionCard,
  };
}
