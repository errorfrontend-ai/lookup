import { ERROR_CATALOG, type ErrorCode } from './error-catalog.js';

/** A field the caller got wrong: its path in the request (e.g. "schedule.0.start") and a reason code. */
export interface FieldIssue {
  path: string;
  code: string;
}

/**
 * An error whose public message was written for the caller (from the catalogue, or an
 * override that is safe to show). `internalDetail` and `cause` go to the private log only.
 * `fields` is public: request field names and reason codes, never the submitted values.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly publicMessage: string;
  readonly internalDetail?: string;
  readonly fields?: readonly FieldIssue[];

  constructor(
    code: ErrorCode,
    options: { publicMessage?: string; internalDetail?: string; cause?: unknown; fields?: readonly FieldIssue[] } = {},
  ) {
    super(options.internalDetail ?? code, { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = ERROR_CATALOG[code].httpStatus;
    this.publicMessage = options.publicMessage ?? ERROR_CATALOG[code].message;
    this.internalDetail = options.internalDetail;
    this.fields = options.fields;
  }
}
