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
  // The listener app from P4: the update gate on every install-token route, and the permanent refusals
  // of a station choice, a button tap or a report, which the phone deletes from its outbox (and reports).
  APP_UPDATE_REQUIRED: { httpStatus: 426, message: 'Please update the app.' },
  STATION_NOT_A_CANDIDATE: { httpStatus: 422, message: "That station isn't one shown for this recording." },
  STATION_ALREADY_CHOSEN: { httpStatus: 422, message: 'A station was already chosen for this recording.' },
  ACTION_NOT_ON_CARD: { httpStatus: 422, message: "That button isn't on this card." },
  RECOGNITION_BUSY: { httpStatus: 503, message: 'Look Up is busy right now. Please try again in a moment.' },
  RECOGNITION_TIMEOUT: { httpStatus: 503, message: 'That took too long. Please try again.' },
  // Station sign-up, the super admin's second factor and the team (phase 5a, P5A design §3.5): each written for the
  // person who meets it, so the portal shows it as it is.
  EMAIL_ALREADY_REGISTERED: { httpStatus: 409, message: 'This email already has an account. Sign in instead.' },
  // SMS_SENDER=none: no code could reach the applicant, so sign-up does not start (P5A design §3.1, O16).
  SIGN_UP_UNAVAILABLE: { httpStatus: 503, message: "Station sign-up isn't open yet. Please try again later." },
  // A logo or licence document that was refused; the reason goes in fields (UPLOAD_REJECTED's words are about audio).
  STATION_FILE_REJECTED: { httpStatus: 400, message: "We can't use this file. Check the type and size, then choose it again." },
  HUMAN_CHECK_FAILED: { httpStatus: 400, message: "We couldn't confirm you're a person. Please do the check again." },
  HUMAN_CHECK_UNAVAILABLE: { httpStatus: 503, message: "We couldn't run the human check just now. Please try again in a minute." },
  VERIFICATION_CODE_INCORRECT: { httpStatus: 400, message: "That code isn't right. Check the SMS and try again." },
  VERIFICATION_CODE_EXPIRED: { httpStatus: 400, message: 'This code has expired. Send yourself a new one.' },
  VERIFICATION_CODE_LOCKED: { httpStatus: 400, message: 'Too many wrong tries. Send yourself a new code.' },
  RESEND_TOO_SOON: { httpStatus: 429, message: 'You can ask for a new one in a minute.' },
  EMAIL_LINK_EXPIRED: { httpStatus: 400, message: 'This link has expired. Ask for a new one on the sign-up page.' },
  EMAIL_LINK_NOT_VALID: { httpStatus: 400, message: "This link doesn't work any more. Ask for a new one on the sign-up page." },
  APPLICATION_INCOMPLETE: { httpStatus: 409, message: "Your application isn't finished yet." },
  APPLICATION_NOT_EDITABLE: { httpStatus: 409, message: "This can't be changed at the moment." },
  CHANGE_REQUEST_ALREADY_OPEN: { httpStatus: 409, message: 'You already have a change waiting for review.' },
  TWO_FACTOR_REQUIRED: { httpStatus: 403, message: 'Enter the code from your authenticator app first.' },
  TWO_FACTOR_CODE_INCORRECT: { httpStatus: 400, message: "That code isn't right. Use the current code in your authenticator app." },
  INVITATION_NOT_VALID: { httpStatus: 400, message: "This invitation link doesn't work. Ask the station's owner for a new one." },
  INVITATION_EXPIRED: { httpStatus: 400, message: "This invitation has expired. Ask the station's owner for a new one." },
  INVITATION_FOR_ANOTHER_EMAIL: { httpStatus: 403, message: 'This invitation was sent to another email address. Sign in with that one.' },
  ALREADY_A_MEMBER: { httpStatus: 409, message: 'This person is already in your team.' },
  LAST_OWNER: { httpStatus: 409, message: 'A station needs at least one owner. Invite another owner first.' },
  STATION_STATUS_CHANGE_NOT_ALLOWED: { httpStatus: 409, message: "This station's status can't change that way." },
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
