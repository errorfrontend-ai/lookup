import { findTwoFactorTimeStep } from '@lookup/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Response } from 'express';
import { ClsService } from 'nestjs-cls';
import type { DataSource } from 'typeorm';
import { AppError } from '../../common/errors/app-error.js';
import { RateLimiter } from '../../common/rate-limiting/rate-limiter.js';
import { DerivedKeys } from '../../common/security/derived-keys.js';
import { TwoFactorSecretBox } from '../../common/security/two-factor-secret-box.js';
import { CLOCK, type Clock } from '../../common/time/clock.js';
import { TWO_FACTOR_FAILURES_PER_ACCOUNT, TWO_FACTOR_FAILURES_PER_ADDRESS } from './authentication-rate-limits.js';
import type { RequestFacts } from './authentication.service.js';

/**
 * The super admin's second factor (P5A design §5.4; P5A-ADMIN-ACCESS-01..10): after the password, a code from the
 * authenticator app, checked against the secret the database keeps sealed. A code counts for its 30-second step and
 * one either side, and each step only once; then this session may open the admin console. Wrong codes are limited
 * per address and per account, and the limits refuse while their store is down.
 */
@Injectable()
export class TwoFactorSignIn {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly requestContext: ClsService,
    private readonly secretBox: TwoFactorSecretBox,
    private readonly rateLimiter: RateLimiter,
    private readonly derivedKeys: DerivedKeys,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async checkCode(typedCode: string, request: RequestFacts, response: Response): Promise<void> {
    const portalUserId = this.requestContext.get<string>('userId');
    const portalSessionId = this.requestContext.get<string>('sessionId');
    const account = this.derivedKeys.hashIdentifier(portalUserId);
    await this.rateLimiter.throwIfFailureLimitReached(TWO_FACTOR_FAILURES_PER_ADDRESS, request.clientAddress, response);
    await this.rateLimiter.throwIfFailureLimitReached(TWO_FACTOR_FAILURES_PER_ACCOUNT, portalUserId, response);

    const [enrolled] = (await this.dataSource.query('SELECT * FROM app.find_two_factor_secret($1)', [portalSessionId])) as Array<{
      portal_user_id: string;
      two_factor_secret_ciphertext: Buffer;
    }>;
    // Not a super admin, or one not enrolled yet: there is no code to check (P5A-D12, SUPPORT included).
    if (!enrolled || enrolled.portal_user_id !== portalUserId) {
      throw new AppError('FORBIDDEN', { internalDetail: `no second factor for account ${account}` });
    }
    const secret = this.secretBox.open(portalUserId, enrolled.two_factor_secret_ciphertext);
    if (!secret) {
      // The key changed, or the row was copied from another account: an operator must enrol the admin again.
      throw new AppError('INTERNAL', { internalDetail: `the second-factor secret of account ${account} does not open` });
    }
    const timeStep = await findTwoFactorTimeStep(secret, typedCode, this.clock.now().getTime());
    const [result] = (await this.dataSource.query('SELECT app.record_two_factor_attempt($1, $2, $3) AS outcome', [
      portalSessionId,
      timeStep,
      request.requestId,
    ])) as Array<{ outcome: 'ACCEPTED' | 'FAILED' | 'CODE_ALREADY_USED' | 'NOT_ALLOWED' }>;
    if (result?.outcome === 'ACCEPTED') {
      await this.rateLimiter.clearFailures(TWO_FACTOR_FAILURES_PER_ACCOUNT, portalUserId);
      return;
    }
    if (result?.outcome === 'NOT_ALLOWED') {
      throw new AppError('FORBIDDEN', { internalDetail: `second factor not allowed for account ${account}` });
    }
    await this.rateLimiter.recordFailure(TWO_FACTOR_FAILURES_PER_ADDRESS, request.clientAddress);
    await this.rateLimiter.recordFailure(TWO_FACTOR_FAILURES_PER_ACCOUNT, portalUserId);
    throw new AppError('TWO_FACTOR_CODE_INCORRECT', { internalDetail: `second factor refused: ${result?.outcome ?? 'no result'} (account ${account})` });
  }
}
