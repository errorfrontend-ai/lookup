/**
 * Every error the API can return, with the plain-language message the caller sees.
 * Messages here are written for people; anything technical stays in the private log.
 */
export const ERROR_CATALOG = {
  BAD_REQUEST: { httpStatus: 400, message: 'The request is not valid.' },
  INVALID_JSON: { httpStatus: 400, message: 'The request body is not valid JSON.' },
  VALIDATION_FAILED: { httpStatus: 400, message: 'Some details are missing or not valid.' },
  UNAUTHENTICATED: { httpStatus: 401, message: 'Please sign in.' },
  // One message for an unknown email, a wrong password and a disabled account, so the answer
  // never reveals which emails have accounts.
  INVALID_CREDENTIALS: { httpStatus: 401, message: 'The email or password is not correct.' },
  FORBIDDEN: { httpStatus: 403, message: 'You do not have access to this.' },
  STATION_NOT_ACTIVE: { httpStatus: 403, message: 'This station is not active yet, so this is not available.' },
  NOT_FOUND: { httpStatus: 404, message: 'Not found.' },
  METHOD_NOT_ALLOWED: { httpStatus: 405, message: 'This action is not allowed here.' },
  CONFLICT: { httpStatus: 409, message: 'This conflicts with something that already exists.' },
  AD_NOT_READY_TO_PUBLISH: { httpStatus: 409, message: "This ad isn't ready to publish yet." },
  UPLOAD_NOT_RECEIVED: { httpStatus: 409, message: "We haven't received the file yet. Please upload it again." },
  UPLOAD_REJECTED: {
    httpStatus: 400,
    message: "The file isn't a supported audio file, or it isn't the file that was expected. Please upload it again.",
  },
  PAYLOAD_TOO_LARGE: { httpStatus: 413, message: 'The upload is too large.' },
  UNSUPPORTED_MEDIA_TYPE: { httpStatus: 415, message: 'This file type is not supported.' },
  RATE_LIMITED: { httpStatus: 429, message: 'Too many requests. Please wait a moment and try again.' },
  // The listener app (Step 3). The app turns each into a screen: update, try again, or no match.
  INSTALL_TOKEN_INVALID: { httpStatus: 401, message: 'This app needs to register again.' },
  INVALID_AUDIO: { httpStatus: 400, message: "That recording couldn't be used. Please try again." },
  RECOGNITION_IN_PROGRESS: { httpStatus: 409, message: 'This recording is still being identified.' },
  CAPTURE_EXPIRED: { httpStatus: 422, message: 'This recording is too old to identify.' },
  CAPTURE_TIME_INVALID: { httpStatus: 422, message: "This recording's time is not valid." },
  RECOGNITION_BUSY: { httpStatus: 503, message: 'Look Up is busy right now. Please try again in a moment.' },
  RECOGNITION_TIMEOUT: { httpStatus: 503, message: 'That took too long. Please try again.' },
  INTERNAL: { httpStatus: 500, message: 'Something went wrong on our side. Please try again.' },
  SERVICE_UNAVAILABLE: { httpStatus: 503, message: 'The service is temporarily unavailable. Please try again shortly.' },
} as const satisfies Record<string, { httpStatus: number; message: string }>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

const ERROR_CODE_BY_HTTP_STATUS: Record<number, ErrorCode> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

/** Catalogue code for an HTTP status that reached the exception filter without one. */
export function errorCodeForHttpStatus(httpStatus: number): ErrorCode {
  return ERROR_CODE_BY_HTTP_STATUS[httpStatus] ?? (httpStatus >= 500 ? 'INTERNAL' : 'BAD_REQUEST');
}
