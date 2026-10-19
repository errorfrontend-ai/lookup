import { randomUUID } from 'node:crypto';
import {
  type CreateListenerAccountInput,
  LISTENER_EMAIL_CODE_RESEND_COOLDOWN_SECONDS,
  type ListenerAccountCodeSent,
  type ListenerAccountSignedIn,
  type ListenerAccountSummary,
  MINIMUM_LISTENER_AGE,
  type VerifyListenerAccountCodeAnswer,
} from '@lookup/contracts';
import { Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { AppError } from '../../common/errors/app-error.js';
import { LISTENER_INSTALL_ID } from '../../common/listener-authentication/install-token.guard.js';
import type { RateLimitRule } from '../../common/rate-limiting/rate-limit-rule.js';
import { RateLimiter } from '../../common/rate-limiting/rate-limiter.js';
import { CLOCK, type Clock } from '../../common/time/clock.js';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { NotificationQueue } from '../notifications/notification-queue.js';
import { ResendTooSoon } from '../registration/phone-verification-codes.js';
import { ListenerAccountRecords } from './listener-account-records.js';
import { ListenerAccountTickets } from './listener-account-tickets.js';
import { ListenerEmailBox, maskEmailAddress } from './listener-email-box.js';
import { ListenerEmailCodes } from './listener-email-codes.js';

const HOUR_SECONDS = 60 * 60;
const DAY_SECONDS = 24 * HOUR_SECONDS;

/**
 * A listener's account (ADR-005, docs/design/listener-accounts.md §4): prove an email with a code, give a gender and
 * an age, and the install belongs to an account the ad results are no longer held back from. Every limit refuses
 * while the counter store is down, so an outage never allows unlimited codes or guesses. The email, the code, the
 * ticket, the gender and the age are never logged: a line says what happened, nothing about whom.
 */
@Injectable()
export class ListenerAccountsService {
  private readonly codesPerInstallPerDay: RateLimitRule;
  private readonly codesPerEmailPerHour: RateLimitRule;
  private readonly codeChecksPerInstallPerHour: RateLimitRule;
  private readonly creationsPerInstallPerDay: RateLimitRule;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly rateLimiter: RateLimiter,
    private readonly emailBox: ListenerEmailBox,
    private readonly emailCodes: ListenerEmailCodes,
    private readonly tickets: ListenerAccountTickets,
    private readonly records: ListenerAccountRecords,
    private readonly notificationQueue: NotificationQueue,
    private readonly requestContext: ClsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('listener-accounts');
    this.codesPerInstallPerDay = { counterName: 'listener-email-codes-per-install-day', maximumRequests: config.LISTENER_EMAIL_CODES_PER_INSTALL_PER_DAY, windowSeconds: DAY_SECONDS, refuseWhenStoreUnavailable: true };
    this.codesPerEmailPerHour = { counterName: 'listener-email-codes-per-email-hour', maximumRequests: config.LISTENER_EMAIL_CODES_PER_EMAIL_PER_HOUR, windowSeconds: HOUR_SECONDS, refuseWhenStoreUnavailable: true };
    this.codeChecksPerInstallPerHour = { counterName: 'listener-email-code-checks-per-install-hour', maximumRequests: config.LISTENER_EMAIL_CODE_CHECKS_PER_INSTALL_PER_HOUR, windowSeconds: HOUR_SECONDS, refuseWhenStoreUnavailable: true };
    this.creationsPerInstallPerDay = { counterName: 'listener-accounts-created-per-install-day', maximumRequests: config.LISTENER_ACCOUNTS_CREATED_PER_INSTALL_PER_DAY, windowSeconds: DAY_SECONDS, refuseWhenStoreUnavailable: true };
  }

  /** Emails a code. The same answer for an address with an account and one without, so it never says which has one. */
  async requestCode(email: string, response: Response): Promise<ListenerAccountCodeSent> {
    const listenerInstallId = this.requestContext.get<string>(LISTENER_INSTALL_ID);
    await this.rateLimiter.countRequest(this.codesPerInstallPerDay, listenerInstallId, response);
    await this.rateLimiter.countRequest(this.codesPerEmailPerHour, email, response);
    let issuedCode;
    try {
      issuedCode = await this.emailCodes.issue(email, this.emailBox.hash(email));
    } catch (problem) {
      if (problem instanceof ResendTooSoon) response.setHeader('Retry-After', String(problem.retryAfterSeconds));
      throw problem;
    }
    await this.notificationQueue.enqueue('email', email, { template: 'listener_email_code', code: issuedCode.code }, this.requestContext.getId());
    this.logger.info({ requestId: this.requestContext.getId() }, 'listener email code sent');
    return { resend_after_seconds: LISTENER_EMAIL_CODE_RESEND_COOLDOWN_SECONDS };
  }

  /**
   * Checks the code. A right one for an address that has an account joins this install to it; for a new address it
   * answers with a ticket for creating the account. Wrong, old and locked codes each have their own error.
   */
  async verifyCode(email: string, typedCode: string, response: Response): Promise<VerifyListenerAccountCodeAnswer> {
    const listenerInstallId = this.requestContext.get<string>(LISTENER_INSTALL_ID);
    await this.rateLimiter.countRequest(this.codeChecksPerInstallPerHour, listenerInstallId, response);
    const emailHash = this.emailBox.hash(email);
    const check = await this.emailCodes.check(email, emailHash, typedCode);
    if (check === 'INCORRECT') throw new AppError('LISTENER_CODE_INCORRECT', { internalDetail: 'a wrong email code was typed' });
    if (check === 'EXPIRED') throw new AppError('LISTENER_CODE_EXPIRED', { internalDetail: 'an email code was typed after it expired, or none was waiting' });
    if (check === 'LOCKED') throw new AppError('LISTENER_CODE_LOCKED', { internalDetail: 'an email code was locked by wrong tries' });

    const outcome = await this.records.linkInstallToExistingAccount(listenerInstallId, emailHash);
    this.logger.info({ requestId: this.requestContext.getId(), outcome }, 'listener email code accepted');
    switch (outcome) {
      case 'LINKED':
      case 'ALREADY_LINKED':
        return { status: 'SIGNED_IN', email_masked: maskEmailAddress(email) };
      case 'NO_ACCOUNT':
        return { status: 'DETAILS_NEEDED', ticket: this.tickets.issue(listenerInstallId, emailHash) };
      case 'LINKED_TO_ANOTHER_ACCOUNT':
        throw new AppError('ALREADY_SIGNED_IN', { internalDetail: 'the install already belongs to another account' });
      case 'NO_INSTALL':
        throw new AppError('INSTALL_TOKEN_INVALID', { internalDetail: 'the install of a valid token has no row' });
    }
  }

  /** Creates the account with the ticket a right code for a new address gave, and joins this install to it. */
  async createAccount(input: CreateListenerAccountInput, response: Response): Promise<ListenerAccountSignedIn> {
    const listenerInstallId = this.requestContext.get<string>(LISTENER_INSTALL_ID);
    await this.rateLimiter.countRequest(this.creationsPerInstallPerDay, listenerInstallId, response);
    const emailHash = this.emailBox.hash(input.email);
    if (!this.tickets.isValid(input.ticket, listenerInstallId, emailHash)) {
      throw new AppError('ACCOUNT_TICKET_NOT_VALID', { internalDetail: 'the ticket is expired, altered, or for another install or address' });
    }
    if (input.age < MINIMUM_LISTENER_AGE) throw new AppError('ACCOUNT_AGE_TOO_YOUNG', { internalDetail: 'the age given is under the minimum' });

    const accountId = randomUUID();
    const outcome = await this.records.createAccountAndLinkInstall({
      accountId,
      listenerInstallId,
      emailHash,
      emailSealed: this.emailBox.seal(accountId, input.email),
      gender: input.gender,
      birthYear: this.clock.now().getUTCFullYear() - input.age,
      consentTextVersion: input.consent_text_version,
      requestId: this.requestContext.getId(),
    });
    this.logger.info({ requestId: this.requestContext.getId(), outcome }, 'listener account created');
    switch (outcome) {
      case 'CREATED':
      case 'LINKED_EXISTING':
      case 'ALREADY_LINKED':
        return { status: 'SIGNED_IN', email_masked: maskEmailAddress(input.email) };
      case 'LINKED_TO_ANOTHER_ACCOUNT':
        throw new AppError('ALREADY_SIGNED_IN', { internalDetail: 'the install already belongs to another account' });
      case 'NO_INSTALL':
        throw new AppError('INSTALL_TOKEN_INVALID', { internalDetail: 'the install of a valid token has no row' });
    }
  }

  /** For Settings: whether this install has an account, and its email masked. */
  async describe(): Promise<ListenerAccountSummary> {
    const account = await this.records.describeAccountOfInstall(this.requestContext.get<string>(LISTENER_INSTALL_ID));
    if (!account) return { is_signed_in: false, email_masked: null };
    const email = this.emailBox.open(account.listenerAccountId, account.emailSealed);
    if (email === null) {
      // The sealed email does not open: the key changed or the row was altered. The listener still has an account.
      this.logger.error({ requestId: this.requestContext.getId() }, 'a sealed listener email did not open');
      return { is_signed_in: true, email_masked: '***' };
    }
    return { is_signed_in: true, email_masked: maskEmailAddress(email) };
  }

  /** Sign out: this install leaves its account. The account and its other installs stay. */
  async signOut(): Promise<void> {
    const outcome = await this.records.unlinkInstall(this.requestContext.get<string>(LISTENER_INSTALL_ID));
    this.logger.info({ requestId: this.requestContext.getId(), outcome }, 'listener signed out');
  }

  /** Deletes the account of this install, with the email, gender and age in it, and unlinks every install. */
  async deleteAccount(): Promise<void> {
    const outcome = await this.records.deleteAccountOfInstall(this.requestContext.get<string>(LISTENER_INSTALL_ID), this.requestContext.getId());
    this.logger.info({ requestId: this.requestContext.getId(), outcome }, 'listener account deleted');
  }
}
