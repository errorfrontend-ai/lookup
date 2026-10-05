import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { QueryFailedError } from 'typeorm';
import { AppError, type FieldIssue } from './app-error.js';
import { ERROR_CATALOG, type ErrorCode, errorCodeForHttpStatus } from './error-catalog.js';

interface PublicError {
  httpStatus: number;
  code: ErrorCode;
  message: string;
  fields?: readonly FieldIssue[];
}

/**
 * Turn any thrown value into the public envelope { error: { code, message, request_id } }.
 * Order matters: database and driver errors are matched first and always become a generic 500,
 * because a driver message is never something a person wrote for a user.
 */
export function toPublicError(exception: unknown): PublicError {
  if (exception instanceof QueryFailedError || isDatabaseDriverError(exception)) {
    return catalogueError('INTERNAL');
  }
  if (exception instanceof AppError) {
    const { httpStatus, code, publicMessage: message, fields } = exception;
    return fields?.length ? { httpStatus, code, message, fields } : { httpStatus, code, message };
  }
  if (exception instanceof HttpException) {
    // Never relay HttpException text: Nest and libraries put technical detail in it.
    return catalogueError(errorCodeForHttpStatus(exception.getStatus()));
  }
  return catalogueError('INTERNAL');
}

function catalogueError(code: ErrorCode): PublicError {
  return { httpStatus: ERROR_CATALOG[code].httpStatus, code, message: ERROR_CATALOG[code].message };
}

/** node-postgres errors carry a five-character SQLSTATE in `code` and a `severity`. */
function isDatabaseDriverError(exception: unknown): boolean {
  if (typeof exception !== 'object' || exception === null || !('severity' in exception)) return false;
  const code: unknown = (exception as { code?: unknown }).code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code);
}

/**
 * The one place errors are logged and answered. Server faults are logged at error level with the
 * stack; caller mistakes at info level without it. The response carries the request id, and so
 * does the log line, so a quoted id finds the full detail.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext('errors');
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & { id?: string }>();
    const response = http.getResponse<Response>();
    const publicError = toPublicError(exception);
    const requestId = request.id ?? 'unknown';
    const error = exception instanceof Error ? exception : new Error(String(exception));

    const record = {
      requestId,
      code: publicError.code,
      httpStatus: publicError.httpStatus,
      method: request.method,
      route: (request.route as { path?: string } | undefined)?.path ?? 'unmatched',
      ...(exception instanceof AppError && exception.internalDetail ? { detail: exception.internalDetail } : {}),
    };
    if (publicError.httpStatus >= 500) this.logger.error({ ...record, err: error }, 'request failed');
    // A caller's mistake needs no stack, unless something underneath caused it (a duplicate key
    // behind a CONFLICT, an unreachable store behind a refusal): then the cause is kept.
    else if (error.cause !== undefined) this.logger.info({ ...record, err: error }, 'request rejected');
    else this.logger.info({ ...record, errorName: error.name }, 'request rejected');

    if (response.headersSent) return;
    const fields = publicError.fields ? { fields: publicError.fields } : {};
    response
      .status(publicError.httpStatus)
      .json({ error: { code: publicError.code, message: publicError.message, request_id: requestId, ...fields } });
  }
}
