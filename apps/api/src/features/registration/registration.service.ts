import { createHash, randomBytes } from 'node:crypto';
import {
  type ApplicationStep,
  type ChangeApplicantAccountInput,
  maskPhoneNumberForDisplay,
  type RegisteredStationApplicant,
  type RegisterStationApplicantInput,
  type SaveStationApplicationDetailsInput,
  type SignedInPortalUser,
  type StationApplication,
  type StationStatus,
} from '@lookup/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Response } from 'express';
import type { Redis } from 'ioredis';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import type { DataSource, EntityManager } from 'typeorm';
import { AppError, type FieldIssue } from '../../common/errors/app-error.js';
import { isUniqueViolation } from '../../common/errors/database-errors.js';
import { RateLimiter } from '../../common/rate-limiting/rate-limiter.js';
import { DerivedKeys } from '../../common/security/derived-keys.js';
import { HUMAN_CHECK, type HumanCheck } from '../../common/security/human-check.js';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { StationScopedTransaction } from '../../infrastructure/database/station-scoped-transaction.js';
import { KEY_VALUE_STORE } from '../../infrastructure/key-value-store/key-value-store.module.js';
import { ObjectStorage } from '../../infrastructure/object-storage/object-storage.js';
import { AuthenticationService, normalizeEmail, type RequestFacts } from '../authentication/authentication.service.js';
import { PasswordHasher } from '../authentication/password-hasher.js';
import { PasswordPolicy } from '../authentication/password-policy.js';
import { createRefreshToken, hashRefreshToken } from '../authentication/session-cookies.js';
import { NotificationQueue } from '../notifications/notification-queue.js';
import { PhoneVerificationCodes, ResendTooSoon } from './phone-verification-codes.js';
import {
  APPLICANTS_PER_PHONE,
  EMAIL_LINKS_SENT_PER_STATION,
  PHONE_CODE_CHECKS_PER_STATION,
  PHONE_CODES_SENT_PER_STATION,
} from './registration-rate-limits.js';

/** A logo link lasts 15 minutes (P5A-D14). */
const LOGO_LINK_SECONDS = 15 * 60;
/** One email link a minute per station, like the phone code (P5A design §3.3). */
const EMAIL_LINK_COOLDOWN_MILLISECONDS = 60_000;

/** The station row as an application reads it (every column the API role may read). */
interface ApplicationRow {
  id: string;
  name: string | null;
  frequency_label: string | null;
  province: string | null;
  city: string | null;
  time_zone: string;
  coverage_note: string | null;
  stream_address: string | null;
  logo_object_key: string | null;
  status: StationStatus;
  contact_name: string | null;
  contact_phone_number_e164: string | null;
  phone_verified_at: Date | null;
  email_verified_at: Date | null;
  licence_number: string | null;
  licence_document_file_name: string | null;
  licence_document_content_type: 'application/pdf' | 'image/jpeg' | null;
  licence_document_byte_count: number | null;
  licence_document_uploaded_at: Date | null;
  licence_confirmed_at: Date | null;
  application_submitted_at: Date | null;
  review_note: string | null;
  reviewed_at: Date | null;
  owner_email: string | null;
}

/** Where each missing part of an application is answered, for APPLICATION_INCOMPLETE's fields. */
const MISSING_PART_FIELDS: Record<string, string> = {
  station_details_missing: 'details',
  licence_number_missing: 'licenceNumber',
  licence_document_missing: 'licenceDocument',
  phone_not_verified: 'phone',
  email_not_verified: 'email',
};

/**
 * Station self sign-up (P5A design §3.3; journeys A, B, D): step 1 creates the account and the station and signs the
 * applicant in; every later step saves to the server through a database function that checks the caller is the
 * station's owner and the application may still change. Codes and links go out through the notify queue.
 */
@Injectable()
export class RegistrationService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(KEY_VALUE_STORE) private readonly keyValueStore: Redis,
    @Inject(HUMAN_CHECK) private readonly humanCheck: HumanCheck,
    private readonly stationScopedTransaction: StationScopedTransaction,
    private readonly requestContext: ClsService,
    private readonly authenticationService: AuthenticationService,
    private readonly passwordHasher: PasswordHasher,
    private readonly passwordPolicy: PasswordPolicy,
    private readonly rateLimiter: RateLimiter,
    private readonly derivedKeys: DerivedKeys,
    private readonly phoneCodes: PhoneVerificationCodes,
    private readonly notifications: NotificationQueue,
    private readonly objectStorage: ObjectStorage,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('registration');
  }

  // ---- step 1 -----------------------------------------------------------------------------------------------

  /**
   * Step 1 (P5A-SIGNUP-04..08): the human check, the password policy, then the account, the station, the OWNER
   * membership and a session in one database call; the applicant is signed in, and the first SMS code and email link
   * are queued. A queueing failure after the account exists is logged, not answered: the Verify step can send again.
   */
  async registerApplicant(
    input: RegisterStationApplicantInput & { mobileNumber: string },
    request: RequestFacts,
    response: Response,
  ): Promise<SignedInPortalUser & RegisteredStationApplicant> {
    if (this.config.SMS_SENDER === 'none') {
      throw new AppError('SIGN_UP_UNAVAILABLE', { internalDetail: 'SMS_SENDER is none: no phone code could be sent' });
    }
    const email = normalizeEmail(input.email);
    await this.rateLimiter.countRequest(APPLICANTS_PER_PHONE, input.mobileNumber, response);
    const verdict = await this.humanCheck.check({ token: input.humanCheckToken, clientAddress: request.clientAddress, idempotencyKey: request.requestId });
    if (!verdict.isPerson) {
      throw new AppError('HUMAN_CHECK_FAILED', {
        internalDetail: `human check refused: ${verdict.errorCodes.join(',') || 'no error codes'}; host ${verdict.isHostnameExpected ? 'expected' : 'unexpected'}, action ${verdict.isActionExpected ? 'expected' : 'unexpected'}`,
      });
    }
    const refusalReason = this.passwordPolicy.check(input.password, { fullName: input.fullName, email, stationNames: [] });
    if (refusalReason) {
      throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'password', code: refusalReason }], internalDetail: `sign-up password refused: ${refusalReason}` });
    }
    const passwordHash = await this.passwordHasher.hashNewPassword(input.password);
    const refreshToken = createRefreshToken();
    let registered: { new_portal_user_id: string; new_station_id: string; new_portal_session_id: string; new_refresh_token_expires_at: Date };
    try {
      [registered] = (await this.dataSource.query('SELECT * FROM app.register_station_applicant($1, $2, $3, $4, $5, $6)', [
        email,
        input.fullName,
        input.mobileNumber,
        passwordHash,
        hashRefreshToken(refreshToken),
        request.requestId,
      ])) as [typeof registered];
    } catch (problem) {
      if (isUniqueViolation(problem, 'portal_users_email_unique')) {
        throw new AppError('EMAIL_ALREADY_REGISTERED', { internalDetail: `sign-up email taken (account ${this.derivedKeys.hashIdentifier(email)})`, cause: problem });
      }
      throw problem;
    }
    const portalUserId = registered.new_portal_user_id;
    const stationId = registered.new_station_id;
    await this.authenticationService.startBrowserSession(
      response,
      portalUserId,
      registered.new_portal_session_id,
      refreshToken,
      registered.new_refresh_token_expires_at,
    );
    const scope = { stationId, userId: portalUserId };
    await this.sendPhoneCodeNow(stationId, input.mobileNumber, email, request.requestId).catch((problem: unknown) => {
      this.logger.warn({ err: problem, requestId: request.requestId }, 'the first phone code was not queued; the applicant can send another');
    });
    await this.sendEmailLinkNow(scope, input.fullName, request.requestId).catch((problem: unknown) => {
      this.logger.warn({ err: problem, requestId: request.requestId }, 'the first email link was not queued; the applicant can send another');
    });
    return { ...(await this.authenticationService.describeSignedInUser(portalUserId)), stationId };
  }

  // ---- the application -----------------------------------------------------------------------------------

  /** Everything saved so far, for any member of the station (P5A-SIGNUP-02, -03). */
  async readApplication(): Promise<StationApplication> {
    const row = await this.stationScopedTransaction.run((database) => this.readApplicationRow(database));
    const codes = await this.phoneCodes.describe(row.id);
    const logoAddress = row.logo_object_key
      ? await this.objectStorage.createDownloadUrlIn(this.objectStorage.stationLogosBucket, row.logo_object_key, LOGO_LINK_SECONDS, {
          contentType: 'image/webp',
          fileName: 'logo.webp',
        })
      : null;
    return {
      stationId: row.id,
      status: row.status,
      account: {
        fullName: row.contact_name ?? '',
        email: row.owner_email ?? '',
        mobileNumber: row.contact_phone_number_e164 ? maskPhoneNumberForDisplay(row.contact_phone_number_e164) : null,
      },
      verification: {
        isPhoneVerified: row.phone_verified_at !== null,
        isEmailVerified: row.email_verified_at !== null,
        phoneCodeSentAt: codes.sentAt?.toISOString() ?? null,
        phoneCodeResendAvailableAt: codes.resendAvailableAt?.toISOString() ?? null,
      },
      details: {
        name: row.name,
        frequencyLabel: row.frequency_label,
        province: row.province,
        city: row.city,
        timeZone: row.time_zone,
        coverageNote: row.coverage_note,
        streamAddress: row.stream_address,
        logoAddress,
      },
      licence: {
        licenceNumber: row.licence_number,
        document:
          row.licence_document_file_name && row.licence_document_content_type && row.licence_document_byte_count && row.licence_document_uploaded_at
            ? {
                fileName: row.licence_document_file_name,
                contentType: row.licence_document_content_type,
                byteCount: row.licence_document_byte_count,
                uploadedAt: row.licence_document_uploaded_at.toISOString(),
              }
            : null,
        confirmedAt: row.licence_confirmed_at?.toISOString() ?? null,
      },
      submittedAt: row.application_submitted_at?.toISOString() ?? null,
      reviewedAt: row.reviewed_at?.toISOString() ?? null,
      rejectionReason: row.status === 'REJECTED' ? row.review_note : null,
      nextStep: nextStepOf(row),
    };
  }

  /** Step 1 changed later: a new phone gets a new code at once, a new email a new link (gap 3). */
  async changeAccount(input: ChangeApplicantAccountInput & { mobileNumber: string }, request: RequestFacts): Promise<StationApplication> {
    const email = normalizeEmail(input.email);
    let changed: { outcome: string; is_phone_number_changed: boolean; is_email_changed: boolean };
    try {
      changed = await this.stationScopedTransaction.run(async (database) => {
        const [row] = (await database.query('SELECT * FROM app.change_applicant_contact(app.current_station_id(), $1, $2, $3, $4)', [
          input.fullName,
          email,
          input.mobileNumber,
          request.requestId,
        ])) as [typeof changed];
        return row;
      });
    } catch (problem) {
      if (isUniqueViolation(problem, 'portal_users_email_unique')) {
        throw new AppError('EMAIL_ALREADY_REGISTERED', { internalDetail: 'changed email taken', cause: problem });
      }
      throw problem;
    }
    this.throwUnlessDone(changed.outcome, 'CHANGED');
    const stationId = this.currentStationId();
    if (changed.is_phone_number_changed) {
      await this.phoneCodes.forget(stationId);
      await this.sendPhoneCodeNow(stationId, input.mobileNumber, email, request.requestId);
    }
    if (changed.is_email_changed) {
      await this.forgetEmailLinkCooldown(stationId);
      await this.sendEmailLinkNow({ stationId, userId: this.currentUserId() }, input.fullName, request.requestId);
    }
    return this.readApplication();
  }

  // ---- step 2: the phone code and the email link ------------------------------------------------------------

  /** Sends (or sends again) the SMS code: at most one a minute (RESEND_TOO_SOON) and 5 an hour per station. */
  async sendPhoneCode(request: RequestFacts, response: Response): Promise<{ sentAt: string; resendAvailableAt: string } | null> {
    const stationId = this.currentStationId();
    const row = await this.stationScopedTransaction.run((database) => this.readApplicationRow(database));
    this.throwUnlessEditable(row.status);
    if (row.phone_verified_at !== null || row.contact_phone_number_e164 === null) return null;
    await this.rateLimiter.countRequest(PHONE_CODES_SENT_PER_STATION, stationId, response);
    try {
      const issued = await this.sendPhoneCodeNow(stationId, row.contact_phone_number_e164, row.owner_email, request.requestId);
      return { sentAt: issued.sentAt.toISOString(), resendAvailableAt: issued.resendAvailableAt.toISOString() };
    } catch (problem) {
      if (problem instanceof ResendTooSoon) response.setHeader('Retry-After', String(problem.retryAfterSeconds));
      throw problem;
    }
  }

  /** Checks a typed SMS code (P5A-VERIFICATION-04, -05): wrong, expired and locked each have their own words. */
  async checkPhoneCode(typedCode: string, request: RequestFacts, response: Response): Promise<void> {
    const stationId = this.currentStationId();
    await this.rateLimiter.countRequest(PHONE_CODE_CHECKS_PER_STATION, stationId, response);
    const row = await this.stationScopedTransaction.run((database) => this.readApplicationRow(database));
    this.throwUnlessEditable(row.status);
    if (row.phone_verified_at !== null) return;
    const phone = row.contact_phone_number_e164 ?? '';
    const check = await this.phoneCodes.check(stationId, phone, typedCode);
    if (check === 'INCORRECT') throw new AppError('VERIFICATION_CODE_INCORRECT', { internalDetail: 'phone code wrong' });
    if (check === 'EXPIRED') throw new AppError('VERIFICATION_CODE_EXPIRED', { internalDetail: 'phone code expired or none sent' });
    if (check === 'LOCKED') throw new AppError('VERIFICATION_CODE_LOCKED', { internalDetail: 'phone code locked after five wrong tries' });
    const [recorded] = (await this.stationScopedTransaction.run((database) =>
      database.query('SELECT app.record_station_phone_verified(app.current_station_id(), $1, $2) AS outcome', [phone, request.requestId]),
    )) as Array<{ outcome: string }>;
    // The phone changed between the check and now: the code was for the old number.
    if (recorded?.outcome === 'PHONE_NUMBER_CHANGED') throw new AppError('VERIFICATION_CODE_INCORRECT', { internalDetail: 'phone changed during the check' });
    this.throwUnlessDone(recorded?.outcome, 'VERIFIED');
  }

  /** Sends the email link again: one a minute, 5 an hour per station. */
  async sendEmailLink(request: RequestFacts, response: Response): Promise<void> {
    const stationId = this.currentStationId();
    await this.rateLimiter.countRequest(EMAIL_LINKS_SENT_PER_STATION, stationId, response);
    const row = await this.stationScopedTransaction.run((database) => this.readApplicationRow(database));
    this.throwUnlessEditable(row.status);
    if (row.email_verified_at !== null) return;
    const waitMilliseconds = await this.keyValueStore
      .set(this.emailLinkCooldownKey(stationId), '1', 'PX', EMAIL_LINK_COOLDOWN_MILLISECONDS, 'NX')
      .then(async (isSet) => (isSet === 'OK' ? 0 : Math.max(1, await this.keyValueStore.pttl(this.emailLinkCooldownKey(stationId)))))
      .catch((problem: unknown) => {
        throw new AppError('SERVICE_UNAVAILABLE', { internalDetail: 'email link cooldown store unavailable', cause: problem });
      });
    if (waitMilliseconds > 0) {
      const tooSoon = new ResendTooSoon(Math.ceil(waitMilliseconds / 1000));
      response.setHeader('Retry-After', String(tooSoon.retryAfterSeconds));
      throw tooSoon;
    }
    await this.sendEmailLinkNow({ stationId, userId: this.currentUserId() }, row.contact_name ?? '', request.requestId);
  }

  /** The email link opened, on any device, signed in or not (P5A-VERIFICATION-09). */
  async confirmEmail(linkToken: string, request: RequestFacts): Promise<void> {
    const [result] = (await this.dataSource.query('SELECT app.confirm_email_verification_link($1, $2) AS outcome', [
      hashLinkToken(linkToken),
      request.requestId,
    ])) as Array<{ outcome: string }>;
    const outcome = result?.outcome;
    if (outcome === 'CONFIRMED' || outcome === 'ALREADY_CONFIRMED') return;
    if (outcome === 'EXPIRED') throw new AppError('EMAIL_LINK_EXPIRED', { internalDetail: 'email link expired' });
    throw new AppError('EMAIL_LINK_NOT_VALID', { internalDetail: `email link refused: ${outcome ?? 'no result'}` });
  }

  // ---- steps 3 and 4, and the submission -------------------------------------------------------------------

  async saveDetails(input: SaveStationApplicationDetailsInput, request: RequestFacts): Promise<StationApplication> {
    const [result] = (await this.stationScopedTransaction.run((database) =>
      database.query('SELECT app.save_station_application_details(app.current_station_id(), $1, $2, $3, $4, $5, $6, $7, $8) AS outcome', [
        input.name,
        input.frequencyLabel,
        input.province,
        input.city,
        input.timeZone,
        input.coverageNote,
        input.streamAddress,
        request.requestId,
      ]),
    )) as Array<{ outcome: string }>;
    if (result?.outcome === 'TIME_ZONE_NOT_VALID') {
      throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'timeZone', code: 'unknown_time_zone' }], internalDetail: 'unknown time zone' });
    }
    this.throwUnlessDone(result?.outcome, 'SAVED');
    return this.readApplication();
  }

  async saveLicenceNumber(licenceNumber: string, request: RequestFacts): Promise<StationApplication> {
    const [result] = (await this.stationScopedTransaction.run((database) =>
      database.query('SELECT app.save_station_licence_number(app.current_station_id(), $1, $2) AS outcome', [licenceNumber, request.requestId]),
    )) as Array<{ outcome: string }>;
    this.throwUnlessDone(result?.outcome, 'SAVED');
    return this.readApplication();
  }

  /** Submit for review, or again after a rejection, once everything is there (P5A-D3); the applicant gets an email. */
  async submit(request: RequestFacts): Promise<StationApplication> {
    const [result] = (await this.stationScopedTransaction.run((database) =>
      database.query('SELECT * FROM app.submit_station_application(app.current_station_id(), $1)', [request.requestId]),
    )) as Array<{ outcome: string; missing_parts: string[] }>;
    if (result?.outcome === 'INCOMPLETE') {
      const fields: FieldIssue[] = result.missing_parts.map((part) => ({ path: MISSING_PART_FIELDS[part] ?? 'application', code: part }));
      throw new AppError('APPLICATION_INCOMPLETE', { fields, internalDetail: `application incomplete: ${result.missing_parts.join(', ')}` });
    }
    if (result?.outcome !== 'SUBMITTED' && result?.outcome !== 'ALREADY_SUBMITTED') this.throwUnlessDone(result?.outcome, 'SUBMITTED');
    const application = await this.readApplication();
    if (result.outcome === 'SUBMITTED' && application.account.email) {
      await this.notifications
        .enqueue('email', application.account.email, { template: 'application_submitted', stationName: application.details.name ?? '' }, request.requestId)
        .catch((problem: unknown) => this.logger.warn({ err: problem, requestId: request.requestId }, 'the submission email was not queued'));
    }
    return application;
  }

  // ---- helpers ---------------------------------------------------------------------------------------------

  private async readApplicationRow(database: EntityManager): Promise<ApplicationRow> {
    const [row] = (await database.query(
      `SELECT station.id, station.name, station.frequency_label, station.province, station.city, station.time_zone,
              station.coverage_note, station.stream_address, station.logo_object_key, station.status, station.contact_name,
              station.contact_phone_number_e164, station.phone_verified_at, station.email_verified_at, station.licence_number,
              station.licence_document_file_name, station.licence_document_content_type, station.licence_document_byte_count,
              station.licence_document_uploaded_at, station.licence_confirmed_at, station.application_submitted_at,
              station.review_note, station.reviewed_at,
              (SELECT owner.email::text FROM app.station_memberships AS membership
                 JOIN app.portal_users AS owner ON owner.id = membership.portal_user_id
                WHERE membership.station_id = station.id AND membership.role = 'OWNER'
                ORDER BY membership.created_at LIMIT 1) AS owner_email
         FROM app.stations AS station WHERE station.id = app.current_station_id()`,
    )) as ApplicationRow[];
    if (!row) throw new AppError('NOT_FOUND', { internalDetail: 'application station not visible' });
    return row;
  }

  /** Issues a code and queues its SMS; `applicantEmail` is where the showcase's stand-in emails it (SMS_SENDER=email-stand-in). */
  private async sendPhoneCodeNow(stationId: string, phoneNumberE164: string, applicantEmail: string | null, requestId: string) {
    const issued = await this.phoneCodes.issue(stationId, phoneNumberE164);
    await this.notifications.enqueue('sms', phoneNumberE164, { template: 'phone_verification_code', code: issued.code }, requestId, { smsStandInEmail: applicantEmail });
    return issued;
  }

  private async sendEmailLinkNow(scope: { stationId: string; userId: string }, fullName: string, requestId: string): Promise<void> {
    const linkToken = randomBytes(32).toString('base64url');
    const [issued] = (await this.stationScopedTransaction.run(
      (database) => database.query('SELECT * FROM app.issue_email_verification_link(app.current_station_id(), $1, $2)', [hashLinkToken(linkToken), requestId]),
      scope,
    )) as Array<{ outcome: string; recipient_email: string | null }>;
    if (issued?.outcome === 'ALREADY_CONFIRMED') return;
    this.throwUnlessDone(issued?.outcome, 'ISSUED');
    await this.notifications.enqueue('email', issued?.recipient_email ?? '', { template: 'email_verification_link', linkToken, fullName }, requestId);
  }

  private emailLinkCooldownKey(stationId: string): string {
    return `email-link-cooldown:${stationId}`;
  }

  private async forgetEmailLinkCooldown(stationId: string): Promise<void> {
    await this.keyValueStore.del(this.emailLinkCooldownKey(stationId)).catch(() => undefined);
  }

  private currentStationId(): string {
    return this.requestContext.get<string>('stationId');
  }

  private currentUserId(): string {
    return this.requestContext.get<string>('userId');
  }

  private throwUnlessEditable(status: StationStatus): void {
    if (status !== 'PENDING_VERIFICATION' && status !== 'PENDING_REVIEW' && status !== 'REJECTED') {
      throw new AppError('APPLICATION_NOT_EDITABLE', { internalDetail: `station is ${status}` });
    }
  }

  /** A function's outcome word other than the one wanted, as the caller's answer. NOT_ALLOWED cannot pass the guard. */
  private throwUnlessDone(outcome: string | undefined, wanted: string): void {
    if (outcome === wanted) return;
    if (outcome === 'NOT_EDITABLE') throw new AppError('APPLICATION_NOT_EDITABLE', { internalDetail: 'application not editable' });
    if (outcome === 'NOT_ALLOWED') throw new AppError('FORBIDDEN', { internalDetail: 'not the station owner in its own context' });
    throw new AppError('INTERNAL', { internalDetail: `unexpected outcome ${outcome ?? 'none'} (wanted ${wanted})` });
  }
}

/** Email links and invitations keep only the SHA-256 of their 32 random bytes (P5A design §5.5). */
export function hashLinkToken(linkToken: string): Buffer {
  return createHash('sha256').update(linkToken, 'utf8').digest();
}

/** The first step with something missing; "submitted" once the application has gone to review (P5A-SIGNUP-03). */
function nextStepOf(row: ApplicationRow): ApplicationStep | 'submitted' {
  if (row.status !== 'PENDING_VERIFICATION') return 'submitted';
  if (row.phone_verified_at === null) return 'verify';
  if (row.name === null || row.frequency_label === null || row.province === null || row.city === null) return 'details';
  return 'licence';
}
