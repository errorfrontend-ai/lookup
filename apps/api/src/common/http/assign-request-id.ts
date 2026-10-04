import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Give every request one id: the caller's X-Request-Id if it is a well-formed UUID (so the app
 * and portal can quote it), otherwise a fresh one. Echoed in the response header, carried into
 * every log line, and returned in every error body.
 */
export function assignRequestId(request: Request & { id?: string }, response: Response, next: NextFunction): void {
  const incomingRequestId = request.headers['x-request-id'];
  const requestId =
    typeof incomingRequestId === 'string' && UUID_PATTERN.test(incomingRequestId)
      ? incomingRequestId.toLowerCase()
      : randomUUID();
  request.id = requestId;
  request.headers['x-request-id'] = requestId;
  response.setHeader('X-Request-Id', requestId);
  next();
}
