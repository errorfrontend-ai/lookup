import { reasonCodeForIssue } from '@lookup/contracts';
import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { AppError } from '../errors/app-error.js';

const MAXIMUM_REPORTED_ISSUES = 20;
const MAXIMUM_PATH_LENGTH = 120;

/**
 * Validates and parses request input against a zod schema: `@Body(new ZodValidationPipe(Schema))`.
 * Every body, query and param that reaches a handler goes through one of these. Schemas use
 * `z.strictObject`, so unknown fields are rejected rather than silently passed along.
 *
 * The caller learns which fields failed and a reason code. Never zod's message text, which can
 * quote the submitted value, and never the names of unknown keys, which the caller chose. A rule
 * of our own (a custom issue) reports its reason only when the reason is one of the fixed codes in
 * VALIDATION_REASON_CODES; anything else reports the generic code "custom".
 */
export class ZodValidationPipe<Schema extends z.ZodType> implements PipeTransform<unknown, z.output<Schema>> {
  constructor(private readonly schema: Schema) {}

  transform(input: unknown): z.output<Schema> {
    const result = this.schema.safeParse(input);
    if (result.success) return result.data;
    const issues = result.error.issues;
    throw new AppError('VALIDATION_FAILED', {
      fields: issues.slice(0, MAXIMUM_REPORTED_ISSUES).map((issue) => ({
        path: issue.path.map(String).join('.').slice(0, MAXIMUM_PATH_LENGTH),
        code: reasonCodeForIssue(issue),
      })),
      internalDetail: `request validation failed: ${issues.length} issue(s)`,
    });
  }
}
