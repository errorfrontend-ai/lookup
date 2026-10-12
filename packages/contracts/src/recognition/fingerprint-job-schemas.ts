import { z } from 'zod';
import { RECOGNITION_CODECS } from './recognize-schemas.js';

/**
 * What the API puts on the BullMQ queues and what the Python workers give back
 * (docs/design/step-3-engine-hookup.md, S3-D2 and S3-D4). The workers' tests check their output
 * against the JSON Schemas emitted from these, so both sides agree on every field.
 */

export const RECOGNIZE_QUEUE_NAME = 'recognize';
export const INGEST_QUEUE_NAME = 'ingest';

/** A listener's clip to fingerprint and look up. Nothing in it identifies the listener or a station. */
export const RecognizeJobData = z
  .strictObject({
    request_id: z.string().min(1).max(64),
    audio_base64: z.string().min(1),
    codec: z.enum(RECOGNITION_CODECS),
    /** After this moment the worker drops the job unread: the API has stopped waiting for it. */
    deadline_epoch_milliseconds: z.number().int().positive(),
    fingerprint_version: z.number().int().positive(),
  })
  .meta({ id: 'RecognizeJobData' });
export type RecognizeJobData = z.infer<typeof RecognizeJobData>;

export const WORKER_RECOGNITION_STATUSES = ['MATCH', 'AMBIGUOUS', 'NO_MATCH', 'EXPIRED'] as const;
export type WorkerRecognitionStatus = (typeof WORKER_RECOGNITION_STATUSES)[number];

export const RecognizeJobResult = z
  .strictObject({
    status: z.enum(WORKER_RECOGNITION_STATUSES),
    /** The matched recording, by its number in the fingerprint store; never an ad or a station. */
    audio_asset_number: z.number().int().positive().nullable(),
    aligned_hash_count: z.number().int().min(0),
    /** Best over second best; null when nothing came second. */
    match_margin: z.number().min(0).nullable(),
    /** Where in the recording the clip starts; slightly negative when the clip begins just before the ad. */
    match_offset_milliseconds: z.number().int().nullable(),
  })
  .meta({ id: 'RecognizeJobResult' });
export type RecognizeJobResult = z.infer<typeof RecognizeJobResult>;

/** A failed recognize job's reason is exactly one of these codes, never error text. */
export const RECOGNIZE_JOB_FAILURE_CODES = ['INVALID_AUDIO', 'DECODE_TIMEOUT', 'LOOKUP_TIMEOUT', 'FINGERPRINT_VERSION_MISMATCH', 'ENGINE_FAILED'] as const;
export type RecognizeJobFailureCode = (typeof RECOGNIZE_JOB_FAILURE_CODES)[number];

/** An uploaded ad to fingerprint. The download address is short-lived; the worker has no storage credentials. */
export const IngestJobData = z
  .strictObject({
    request_id: z.string().min(1).max(64),
    ad_id: z.uuid(),
    download_address: z.url().max(4096),
    deadline_epoch_milliseconds: z.number().int().positive(),
    fingerprint_version: z.number().int().positive(),
  })
  .meta({ id: 'IngestJobData' });
export type IngestJobData = z.infer<typeof IngestJobData>;

/** READY: fingerprinted (or linked to an identical recording). REFUSED: the file can't be used. SKIPPED: the ad no longer waited. EXPIRED: too late. */
export const INGEST_OUTCOMES = ['READY', 'REFUSED', 'SKIPPED', 'EXPIRED'] as const;

export const IngestJobResult = z
  .strictObject({
    outcome: z.enum(INGEST_OUTCOMES),
    is_linked_to_existing_audio: z.boolean(),
  })
  .meta({ id: 'IngestJobResult' });
export type IngestJobResult = z.infer<typeof IngestJobResult>;

/**
 * A stored recording to fingerprint again with the workers' current version (ADR-001, "Real captures, October
 * 2026"). It travels on the ingest queue under its own job name; the address reads the original upload of one of
 * the recording's ads, and no ad changes: the worker writes the version's hash table and records the new version.
 */
export const REFINGERPRINT_JOB_NAME = 'refingerprint';

export const RefingerprintJobData = z
  .strictObject({
    request_id: z.string().min(1).max(64),
    /** The recording, by its number in the fingerprint store; never an ad or a station. */
    audio_asset_number: z.number().int().positive(),
    download_address: z.url().max(4096),
    deadline_epoch_milliseconds: z.number().int().positive(),
    fingerprint_version: z.number().int().positive(),
  })
  .meta({ id: 'RefingerprintJobData' });
export type RefingerprintJobData = z.infer<typeof RefingerprintJobData>;

/**
 * REFINGERPRINTED: the new version's hashes are stored. SKIPPED: the recording was already on that version (or is
 * gone). REFUSED: the download was not the stored recording, or could not be read; nothing changed. EXPIRED: too late.
 */
export const REFINGERPRINT_OUTCOMES = ['REFINGERPRINTED', 'SKIPPED', 'REFUSED', 'EXPIRED'] as const;

export const RefingerprintJobResult = z
  .strictObject({
    outcome: z.enum(REFINGERPRINT_OUTCOMES),
    /** How many hashes the new version stored; null unless REFINGERPRINTED. */
    hash_count: z.number().int().min(0).nullable(),
  })
  .meta({ id: 'RefingerprintJobResult' });
export type RefingerprintJobResult = z.infer<typeof RefingerprintJobResult>;

const emitJobSchema = (schema: z.ZodType, id: string, io: 'input' | 'output') => () => ({
  $id: `https://contracts.lookup.invalid/${id}/1.json`,
  ...z.toJSONSchema(schema, { target: 'draft-2020-12', io, unrepresentable: 'throw' }),
});
export const emitRecognizeJobDataJsonSchema = emitJobSchema(RecognizeJobData, 'recognize-job-data', 'output');
export const emitRecognizeJobResultJsonSchema = emitJobSchema(RecognizeJobResult, 'recognize-job-result', 'output');
export const emitIngestJobDataJsonSchema = emitJobSchema(IngestJobData, 'ingest-job-data', 'output');
export const emitIngestJobResultJsonSchema = emitJobSchema(IngestJobResult, 'ingest-job-result', 'output');
export const emitRefingerprintJobDataJsonSchema = emitJobSchema(RefingerprintJobData, 'refingerprint-job-data', 'output');
export const emitRefingerprintJobResultJsonSchema = emitJobSchema(RefingerprintJobResult, 'refingerprint-job-result', 'output');
