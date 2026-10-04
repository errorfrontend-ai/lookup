import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../errors/app-error.js';
import type { ErrorCode } from '../errors/error-catalog.js';

const ERROR_CODE_BY_PARSER_FAILURE: Record<string, ErrorCode> = {
  'entity.parse.failed': 'INVALID_JSON',
  'entity.too.large': 'PAYLOAD_TOO_LARGE',
};

/**
 * Body-parser failures arrive as plain errors that Nest would turn into a 500 (too large) or
 * relay the parser's message for. Turn them into catalogue errors and hand them on to the central
 * exception filter, which logs and answers like everywhere else. The parser's message can hold a
 * fragment of the user's input, so only the failure type goes into the log.
 */
export function mapBodyParserErrors(error: unknown, _request: Request, _response: Response, next: NextFunction): void {
  const failureType = typeof error === 'object' && error !== null ? (error as { type?: unknown }).type : undefined;
  if (typeof failureType !== 'string') return next(error);
  const code = ERROR_CODE_BY_PARSER_FAILURE[failureType] ?? 'BAD_REQUEST';
  next(new AppError(code, { internalDetail: `request body rejected by parser: ${failureType}` }));
}
