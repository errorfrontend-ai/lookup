import { type ActionCard, type RecognitionResult, RecognizeResponse } from '@lookup/contracts';
import type { CardKind, StationCandidate, StationResolution } from './resolve-station.js';

/** What every answer to a clip carries, whatever its status. */
export interface AnswerBasics {
  recognitionId: string;
  requestId: string;
  /** As stored: the app's flag, or a late arrival, on any attempt (contract §1.2). */
  isDeferred: boolean;
  /** As stored: the corrected moment the clip was first heard. */
  capturedAt: Date;
}

/** One station's answer as a listener sees it: the station, the advertiser, the ad and the card shown. */
export interface ShownStation {
  stationId: string;
  stationName: string;
  frequencyLabel: string;
  city: string | null;
  clientName: string;
  adTitle: string;
  cardKind: CardKind;
  card: ActionCard;
}

/**
 * A finished recognition as recognition.describe_recognition_for_replay gives it back: one row for a match, one
 * row per shown station in display order for a chooser (before or after the choice), one row without a station
 * otherwise.
 */
export interface ReplayRow {
  outcome: string;
  is_deferred: boolean;
  captured_at: Date;
  display_position: number | null;
  card_kind: CardKind | null;
  station_id: string | null;
  station_name: string | null;
  station_frequency_label: string | null;
  station_city: string | null;
  is_station_active: boolean | null;
  client_name: string | null;
  ad_title: string | null;
  action_card: ActionCard | null;
}

/** A station as the shared ListenerStation, a card as the shared ListenerCard. Logos and header images wait for uploads (S3-D21). */
export function toRecognitionResult(shown: ShownStation): RecognitionResult {
  return {
    kind: shown.cardKind,
    station: { id: shown.stationId, name: shown.stationName, frequency_label: shown.frequencyLabel, city: shown.city, logo: null },
    client: { name: shown.clientName, logo: null },
    title: shown.adTitle,
    card: { schema_version: shown.card.schema_version, layout: shown.card.layout, header_image: null, actions: shown.card.actions },
  };
}

function fromCandidate(candidate: StationCandidate): ShownStation {
  return {
    stationId: candidate.stationId,
    stationName: candidate.stationName,
    frequencyLabel: candidate.frequencyLabel,
    city: candidate.city,
    clientName: candidate.clientName,
    adTitle: candidate.adTitle,
    cardKind: candidate.cardKind,
    card: candidate.card,
  };
}

/**
 * Every answer is checked against the shared contract before it leaves, so nothing outside it can: no internal
 * id, no score, a chooser of 2 to 4 distinct stations, every station with its city or null.
 */
function checkedAnswer(basics: AnswerBasics, body: { status: 'NO_MATCH' } | { status: 'MATCH'; result: RecognitionResult } | { status: 'CHOOSE_STATION'; candidates: RecognitionResult[] }): RecognizeResponse {
  return RecognizeResponse.parse({
    ...body,
    recognition_id: basics.recognitionId,
    request_id: basics.requestId,
    is_deferred: basics.isDeferred,
    captured_at: basics.capturedAt.toISOString(),
  });
}

export function answerNoMatch(basics: AnswerBasics): RecognizeResponse {
  return checkedAnswer(basics, { status: 'NO_MATCH' });
}

/**
 * The ad's result held back until the listener has an account (ADR-005, LA-GATE-01): only the common fields of the
 * answer it replaces, so nothing about the ad, the station or the advertiser leaves the server. Anything that is not an
 * ad's result (no match) is returned as it is.
 */
export function withholdAdResult(answer: RecognizeResponse): RecognizeResponse {
  if (answer.status !== 'MATCH' && answer.status !== 'CHOOSE_STATION') return answer;
  return RecognizeResponse.parse({
    status: 'ACCOUNT_REQUIRED',
    recognition_id: answer.recognition_id,
    request_id: answer.request_id,
    is_deferred: answer.is_deferred,
    captured_at: answer.captured_at,
  });
}

/** The answer to a clip that was just resolved: a match, a chooser with every shown station's card inline, or no match. */
export function answerResolution(basics: AnswerBasics, resolution: StationResolution): RecognizeResponse {
  switch (resolution.outcome) {
    case 'NO_MATCH':
      return answerNoMatch(basics);
    case 'MATCH':
    case 'MATCH_DEFAULT':
      return checkedAnswer(basics, { status: 'MATCH', result: toRecognitionResult(fromCandidate(resolution.matched)) });
    case 'CHOOSE_STATION':
      return checkedAnswer(basics, { status: 'CHOOSE_STATION', candidates: resolution.shownCandidates.map((candidate) => toRecognitionResult(fromCandidate(candidate))) });
  }
}

/**
 * A finished recognition answered again (P4 design §5.4, P4-D13): the same id, status, card versions and, for a
 * chooser, the same stations in the same order, also after the listener's choice. A station that is no longer
 * ACTIVE is left out: a match becomes NO_MATCH with the same id; a chooser left with one station becomes a MATCH
 * with that station's stored card, and with none a NO_MATCH. NO_MATCH and AMBIGUOUS replay as NO_MATCH. The
 * deferred flag and the capture time are the stored ones. (INVALID_AUDIO is answered 400 again by the caller.)
 */
export function answerReplay(basics: Pick<AnswerBasics, 'recognitionId' | 'requestId'>, rows: readonly ReplayRow[]): RecognizeResponse {
  const [first] = rows;
  if (!first) throw new Error('a replay needs the stored recognition');
  const storedBasics: AnswerBasics = { ...basics, isDeferred: first.is_deferred, capturedAt: first.captured_at };
  if (!['MATCH', 'MATCH_DEFAULT', 'CHOOSE_STATION'].includes(first.outcome)) return answerNoMatch(storedBasics);

  const stillShown: ShownStation[] = rows.flatMap((row) =>
    row.is_station_active && row.station_id && row.station_name && row.station_frequency_label && row.client_name && row.ad_title && row.card_kind && row.action_card
      ? [
          {
            stationId: row.station_id,
            stationName: row.station_name,
            frequencyLabel: row.station_frequency_label,
            city: row.station_city,
            clientName: row.client_name,
            adTitle: row.ad_title,
            cardKind: row.card_kind,
            card: row.action_card,
          },
        ]
      : [],
  );
  if (stillShown.length === 0) return answerNoMatch(storedBasics);
  if (stillShown.length === 1) return checkedAnswer(storedBasics, { status: 'MATCH', result: toRecognitionResult(stillShown[0] as ShownStation) });
  return checkedAnswer(storedBasics, { status: 'CHOOSE_STATION', candidates: stillShown.map(toRecognitionResult) });
}
