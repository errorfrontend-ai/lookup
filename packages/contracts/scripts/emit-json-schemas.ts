/**
 * Writes the JSON Schema files that non-TypeScript readers (the Flutter listener app) use.
 * Run after changing a schema: `npm run emit-json-schemas -w @lookup/contracts`. A test fails when
 * the committed files and the schemas drift apart.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { emitActionCardJsonSchema } from '../src/action-card/action-card-schema.js';
import { emitClientErrorReportJsonSchema } from '../src/client-errors/client-error-schemas.js';
import { emitErrorEnvelopeJsonSchema } from '../src/errors/error-envelope-schema.js';
import {
  emitCreateListenerAccountInputJsonSchema,
  emitListenerAccountCodeSentJsonSchema,
  emitListenerAccountSignedInJsonSchema,
  emitListenerAccountSummaryJsonSchema,
  emitRequestListenerAccountCodeInputJsonSchema,
  emitVerifyListenerAccountCodeAnswerJsonSchema,
  emitVerifyListenerAccountCodeInputJsonSchema,
} from '../src/listener-accounts/listener-account-schemas.js';
import { emitRecordEngagementInputJsonSchema } from '../src/recognition/engagement-schemas.js';
import {
  emitIngestJobDataJsonSchema,
  emitIngestJobResultJsonSchema,
  emitRecognizeJobDataJsonSchema,
  emitRecognizeJobResultJsonSchema,
  emitRefingerprintJobDataJsonSchema,
  emitRefingerprintJobResultJsonSchema,
} from '../src/recognition/fingerprint-job-schemas.js';
import { emitInstallRegistrationJsonSchema, emitRegisterInstallInputJsonSchema } from '../src/recognition/listener-install-schemas.js';
import { emitListenerStationListJsonSchema } from '../src/recognition/listener-station-schemas.js';
import { emitReportRecognitionInputJsonSchema } from '../src/recognition/recognition-report-schemas.js';
import { emitRecognizeRequestFieldsJsonSchema, emitRecognizeResponseJsonSchema } from '../src/recognition/recognize-schemas.js';
import { emitRecognitionStationChoiceInputJsonSchema } from '../src/recognition/station-choice-schemas.js';

export const JSON_SCHEMA_FILES = {
  'action-card.schema.json': emitActionCardJsonSchema,
  'error-envelope.schema.json': emitErrorEnvelopeJsonSchema,
  'client-error-report.schema.json': emitClientErrorReportJsonSchema,
  'register-install-input.schema.json': emitRegisterInstallInputJsonSchema,
  'install-registration.schema.json': emitInstallRegistrationJsonSchema,
  'recognize-request-fields.schema.json': emitRecognizeRequestFieldsJsonSchema,
  'recognize-response.schema.json': emitRecognizeResponseJsonSchema,
  'listener-station-list.schema.json': emitListenerStationListJsonSchema,
  'recognition-station-choice-input.schema.json': emitRecognitionStationChoiceInputJsonSchema,
  'record-engagement-input.schema.json': emitRecordEngagementInputJsonSchema,
  'report-recognition-input.schema.json': emitReportRecognitionInputJsonSchema,
  'recognize-job-data.schema.json': emitRecognizeJobDataJsonSchema,
  'recognize-job-result.schema.json': emitRecognizeJobResultJsonSchema,
  'ingest-job-data.schema.json': emitIngestJobDataJsonSchema,
  'ingest-job-result.schema.json': emitIngestJobResultJsonSchema,
  'refingerprint-job-data.schema.json': emitRefingerprintJobDataJsonSchema,
  'refingerprint-job-result.schema.json': emitRefingerprintJobResultJsonSchema,
  'request-listener-account-code-input.schema.json': emitRequestListenerAccountCodeInputJsonSchema,
  'verify-listener-account-code-input.schema.json': emitVerifyListenerAccountCodeInputJsonSchema,
  'create-listener-account-input.schema.json': emitCreateListenerAccountInputJsonSchema,
  'listener-account-code-sent.schema.json': emitListenerAccountCodeSentJsonSchema,
  'verify-listener-account-code-answer.schema.json': emitVerifyListenerAccountCodeAnswerJsonSchema,
  'listener-account-signed-in.schema.json': emitListenerAccountSignedInJsonSchema,
  'listener-account-summary.schema.json': emitListenerAccountSummaryJsonSchema,
};

export function formatJsonSchema(schema: Record<string, unknown>): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const [fileName, emit] of Object.entries(JSON_SCHEMA_FILES)) {
    writeFileSync(resolve(import.meta.dirname, '..', 'schemas', fileName), formatJsonSchema(emit()), 'utf8');
    console.log(`wrote schemas/${fileName}`);
  }
}
