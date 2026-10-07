import { z } from 'zod';
import { ACTION_CARD_SCHEMA_VERSION, CardAction, CardLayout, checkActionCardRules, MAXIMUM_ACTIONS_PER_CARD } from '../action-card/action-card-schema.js';
import { MAXIMUM_AD_TITLE_LENGTH } from '../ads/ad-schemas.js';

// ---- the request ------------------------------------------------------------------------------------

/** A listener's clip: 2 to 15 seconds, at most 256 KiB, AAC in MP4/M4A (`ftyp`) or Opus in Ogg (`OggS`). */
export const MINIMUM_CLIP_DURATION_MILLISECONDS = 2_000;
export const MAXIMUM_CLIP_DURATION_MILLISECONDS = 15_000;
export const MAXIMUM_CLIP_BYTES = 262_144;
export const RECOGNITION_CODECS = ['aac', 'opus'] as const;
export type RecognitionCodec = (typeof RECOGNITION_CODECS)[number];

/**
 * POST /api/v1/recognize is `multipart/form-data`: the clip as the file part `audio`, and these text
 * fields. Every request, live or sent later from the phone's outbox, carries the idempotency key made
 * when the clip was recorded, the phone's time at capture and at sending, and whether it was held back.
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
    /** The listener's "My station", by its id. Step 3 checks it; using it to choose a station comes in P4. */
    station_hint: z.uuid().optional(),
  })
  .meta({ id: 'RecognizeRequestFields' });
export type RecognizeRequestFields = z.output<typeof RecognizeRequestFields>;

// ---- the response -----------------------------------------------------------------------------------

/** An image a listener's phone downloads: where, its size in pixels and in bytes (for data saving). */
export const PublicImage = z
  .strictObject({
    address: z.string().max(2048).regex(/^https:\/\/[^\s/?#]+[^\s]*$/),
    width_pixels: z.number().int().min(1).max(4096),
    height_pixels: z.number().int().min(1).max(4096),
    size_bytes: z.number().int().min(1),
  })
  .meta({ id: 'PublicImage' });

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

/** CAMPAIGN: the ad was on air when it was heard. CLIENT_DEFAULT: it was not, so the advertiser's own card is shown. */
export const RECOGNITION_RESULT_KINDS = ['CAMPAIGN', 'CLIENT_DEFAULT'] as const;

export const RecognitionResult = z
  .strictObject({
    kind: z.enum(RECOGNITION_RESULT_KINDS),
    station: z.strictObject({
      /** The station's id: the one public reference to it, also used as the hint and, in P4, the listener's choice. */
      id: z.uuid(),
      name: z.string().min(1).max(120),
      frequency_label: z.string().min(1).max(32),
      logo: PublicImage.nullable(),
    }),
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

const commonResponseFields = {
  recognition_id: z.string().regex(UUID_VERSION_7),
  request_id: z.string().min(1).max(64),
  is_deferred: z.boolean(),
  /** When the clip was heard, corrected for the phone's clock. */
  captured_at: z.iso.datetime({ offset: true }),
};

/**
 * The answer to a clip. Nothing internal is ever in it: no audio asset, campaign or install, no match
 * scores, and no station field but the public ones. An AMBIGUOUS engine result is answered NO_MATCH.
 */
export const RecognizeResponse = z
  .discriminatedUnion('status', [
    z.strictObject({ status: z.literal('MATCH'), ...commonResponseFields, result: RecognitionResult }),
    z.strictObject({ status: z.literal('NO_MATCH'), ...commonResponseFields }),
    // Produced from P4, when the ad is on air at several stations: the listener picks theirs.
    z.strictObject({ status: z.literal('CHOOSE_STATION'), ...commonResponseFields, candidates: z.array(RecognitionResult).min(2).max(4) }),
  ])
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
