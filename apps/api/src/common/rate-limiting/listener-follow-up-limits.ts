import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { AppError } from '../errors/app-error.js';
import { LISTENER_INSTALL_ID } from '../listener-authentication/install-token.guard.js';
import type { RateLimitRule } from './rate-limit-rule.js';
import { RateLimiter } from './rate-limiter.js';

/**
 * The follow-up allowance (P4 design §5.11, P4-D29): a station choice, a button tap and a report each count against
 * one allowance per install, RECOGNITION_FOLLOW_UPS_PER_INSTALL_PER_MINUTE, refused with 429 RATE_LIMITED and
 * Retry-After. It is independent of the clip allowances, so a paused clip says nothing about choices or taps.
 *
 * Listed after InstallTokenGuard in `@UseGuards(InstallTokenGuard, ListenerFollowUpLimitGuard)`, so it counts only
 * requests with a valid token, by install and never by address, and before the path and the body are checked
 * (contract §1.0, Correction 1).
 */
@Injectable()
export class ListenerFollowUpLimitGuard implements CanActivate {
  private readonly followUpsPerInstall: RateLimitRule;

  constructor(
    private readonly rateLimiter: RateLimiter,
    private readonly requestContext: ClsService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.followUpsPerInstall = {
      counterName: 'recognition-follow-ups-per-install-minute',
      maximumRequests: config.RECOGNITION_FOLLOW_UPS_PER_INSTALL_PER_MINUTE,
      windowSeconds: 60,
    };
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const listenerInstallId = this.requestContext.get<string | undefined>(LISTENER_INSTALL_ID);
    // Only reachable if the guards were listed in the wrong order: refuse rather than count every install as one.
    if (!listenerInstallId) throw new AppError('INTERNAL', { internalDetail: 'follow-up allowance checked before the install token' });
    await this.rateLimiter.countRequest(this.followUpsPerInstall, listenerInstallId, context.switchToHttp().getResponse<Response>());
    return true;
  }
}
