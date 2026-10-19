import { z } from 'zod';
import { ACTION_CARD_SCHEMA_VERSION, CardAction, CardLayout, checkActionCardRules, MAXIMUM_ACTIONS_PER_CARD } from '../action-card/action-card-schema.js';
import { MAXIMUM_AD_TITLE_LENGTH } from '../ads/ad-schemas.js';
import { ListenerStation } from './listener-station-schemas.js';
import { PublicImage } from './public-image-schema.js';

// ---- the request ------------------------------------------------------------------------------------

/** A listener's clip: 2 to 15 seconds, at most 256 KiB, AAC in MP4/M4A (`ftyp`) or Opus in Ogg (`OggS`). */
export const MINIMUM_CLIP_DURATION_MILLISECONDS = 2_000;
export const MAXIMUM_CLIP_DURATION_MILLISECONDS = 15_000;
export const MAXIMUM_CLIP_BYTES = 262_144;
export const RECOGNITION_CODECS = ['aac', 'opus'] as const;
export type RecognitionCodec = (typeof RECOGNITION_CODECS)[number];

/**
 * Problems with the recognize form itself that its fields' schema cannot see, relayed in
 * VALIDATION_FAILED. `audio_part_before_fields`: the audio part arrived before every text field had.
 */
export const RECOGNIZE_REQUEST_REASONS = ['audio_part_before_fields'] as const;
export type RecognizeRequestReason = (typeof RECOGNIZE_REQUEST_REASONS)[number];

/**
 * POST /api/v1/recognize is `multipart/form-data`: these text fields, then the clip as the file part
 * `audio`, which must come last. The server reads the fields before any audio, so it can count the
 * request against the right allowance first: an audio part that arrives before every text field is
 * refused (VALIDATION_FAILED, path `audio`, reason `audio_part_before_fields`).
 *
 * Every request, live or sent later from the phone's outbox, carries the idempotency key made when
 * the clip was recorded and the phone's time at capture. A send from the outbox keeps the original
 * key and capture time and takes `sent_at` afresh before every attempt. `is_deferred` is "true" for
 * every send from the outbox and "false" for every live one; as sent, it chooses the per-install
 * allowance, the admission threshold, the Retry-After range, the queue priority and the wait.
 */
export const RecognizeRequestFields = z
  .strictObject({
    clip_duration_milliseconds: z
      .string()
      .regex(/^[0-9]{1,6}$/)
      .transform(Number)
      .pipe(z.number().int().min(MINIMUM_CLIP_DURATION_MILLISECONDS).max(MAXIMUM_CLIP_DURATION_MILLISECONDS)),
    codec: z.enum(RECOGNITION_CODECS),
    idempotency_key: z.uuid(),
    captured_at: z.iso.datetime({ offset: true }),
    sent_at: z.iso.datetime({ offset: true }),
    is_deferred: z.enum(['true', 'false']).transform((value) => value === 'true'),
    /**
     * The listener's "My station" at the moment of capture, by its id (kept with a clip in the outbox).
     * A hint the server cannot use (an unknown, suspended or not-a-candidate station) is ignored, never refused.
     */
    station_hint: z.uuid().optional(),
  })
  .meta({ id: 'RecognizeRequestFields' });
export type RecognizeRequestFields = z.output<typeof RecognizeRequestFields>;

// ---- the response -----------------------------------------------------------------------------------

/**
 * A card as the listener app renders it: the station's buttons, in order, and an optional header image.
 * It keeps every rule of a saved action card, so an answer can never carry a button the portal would refuse.
 */
export const ListenerCard = z
  .strictObject({
    schema_version: z.literal(ACTION_CARD_SCHEMA_VERSION),
    layout: CardLayout,
    header_image: PublicImage.nullable(),
    actions: z.array(CardAction).min(1).max(MAXIMUM_ACTIONS_PER_CARD),
  })
  .superRefine(checkActionCardRules)
  .meta({ id: 'ListenerCard' });
export type ListenerCard = z.infer<typeof ListenerCard>;

/**
 * CAMPAIGN: the ad was on air when it was heard, so the campaign's card is shown. CLIENT_DEFAULT: the
 * advertiser's usual card is shown instead, because the ad was out of its slots, or its campaign was
 * paused or ended after the clip was heard, or reached its tap limit.
 */
export const RECOGNITION_RESULT_KINDS = ['CAMPAIGN', 'CLIENT_DEFAULT'] as const;

export const RecognitionResult = z
  .strictObject({
    kind: z.enum(RECOGNITION_RESULT_KINDS),
    station: ListenerStation,
    client: z.strictObject({
      name: z.string().min(1).max(80),
      logo: PublicImage.nullable(),
    }),
    title: z.string().min(1).max(MAXIMUM_AD_TITLE_LENGTH),
    card: ListenerCard,
  })
  .meta({ id: 'RecognitionResult' });
export type RecognitionResult = z.infer<typeof RecognitionResult>;

/** UUID version 7: time-ordered, so recognitions sort in the order they were made. */
const UUID_VERSION_7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * A recognition's id, as the answer gives it and as the follow-ups (the station choice, taps and
 * reports) name it. Deliberately without a registry id: the emitted JSON Schemas then hold it inline
 * as a plain string property, never as a `$ref` the listener app's schema checker cannot follow.
 */
export const RecognitionId = z.string().regex(UUID_VERSION_7).describe('A recognition id: a lower-case UUID version 7');

/** A "Which station?" answer offers 2 to 4 stations, in the server's display order. */
export const MINIMUM_CHOOSER_CANDIDATES = 2;
export const MAXIMUM_CHOOSER_CANDIDATES = 4;

/**
 * Rules of the recognize answer that JSON Schema cannot express, checked by zod only. They are rules of
 * what the server sends, never of what a caller sent, so they are not relayed in VALIDATION_FAILED.
 */
export const RECOGNIZE_RESPONSE_RULE_REASONS = ['candidate_station_repeated'] as const;
export type RecognizeResponseRuleReason = (typeof RECOGNIZE_RESPONSE_RULE_REASONS)[number];

const commonResponseFields = {
  recognition_id: RecognitionId,
  request_id: z.string().min(1).max(64),
  is_deferred: z.boolean(),
  /** When the clip was heard, corrected for the phone's clock. */
  captured_at: z.iso.datetime({ offset: true }),
};

/**
 * The answer to a clip. Nothing internal is ever in it: no audio asset, campaign, card id or install,
 * no match scores, counters or limits, and no station field but the public ones. NO_MATCH: no station
 * owns the recording, or none has a card to show (an AMBIGUOUS engine result is answered NO_MATCH too).
 * CHOOSE_STATION: several stations could answer and none could be picked for the listener; it carries
 * every candidate's card inline, each station once, in the order the app must show them, and never a
 * `result`. How a MATCH was decided (one owner, the schedule, the hint) is never sent.
 * ACCOUNT_REQUIRED (ADR-005): the clip was recognised as an ad, but the install has no listener account yet,
 * so the server holds the result back: this answer carries nothing but the common fields (no station, client,
 * title or card). The app asks the listener to create an account, then fetches the result with
 * `GET /api/v1/recognitions/{recognition_id}`, which answers with the MATCH or CHOOSE_STATION it withheld.
 */
export const RecognizeResponse = z
  .discriminatedUnion('status', [
    z.strictObject({ status: z.literal('MATCH'), ...commonResponseFields, result: RecognitionResult }),
    z.strictObject({ status: z.literal('NO_MATCH'), ...commonResponseFields }),
    z.strictObject({ status: z.literal('ACCOUNT_REQUIRED'), ...commonResponseFields }),
    z.strictObject({
      status: z.literal('CHOOSE_STATION'),
      ...commonResponseFields,
      candidates: z.array(RecognitionResult).min(MINIMUM_CHOOSER_CANDIDATES).max(MAXIMUM_CHOOSER_CANDIDATES),
    }),
  ])
  .superRefine((response, context) => {
    if (response.status !== 'CHOOSE_STATION') return;
    const seenStationIds = new Set<string>();
    response.candidates.forEach((candidate, candidateIndex) => {
      if (seenStationIds.has(candidate.station.id)) {
        const reason: RecognizeResponseRuleReason = 'candidate_station_repeated';
        context.addIssue({ code: 'custom', path: ['candidates', candidateIndex, 'station', 'id'], params: { reason }, message: reason });
      }
      seenStationIds.add(candidate.station.id);
    });
  })
  .meta({ id: 'RecognizeResponse' });
export type RecognizeResponse = z.infer<typeof RecognizeResponse>;
export type RecognitionStatus = RecognizeResponse['status'];

export function emitRecognizeRequestFieldsJsonSchema(): Record<string, unknown> {
  return {
    $id: 'https://contracts.lookup.invalid/recognize-request-fields/1.json',
    ...z.toJSONSchema(RecognizeRequestFields, { target: 'draft-2020-12', io: 'input', unrepresentable: 'throw' }),
  };
}

export function emitRecognizeResponseJsonSchema(): Record<string, unknown> {
  return {
    $id: 'https://contracts.lookup.invalid/recognize-response/1.json',
    ...z.toJSONSchema(RecognizeResponse, { target: 'draft-2020-12', io: 'output', unrepresentable: 'throw' }),
  };
}
