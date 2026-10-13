import { type InstallRegistration, RegisterInstallInput } from '@lookup/contracts';
import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { RateLimitRule } from '../../common/rate-limiting/rate-limit-rule.js';
import { RateLimiter } from '../../common/rate-limiting/rate-limiter.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { PublicRoute } from '../authentication/public-route.decorator.js';
import { ListenerInstallsService } from './listener-installs.service.js';

/**
 * POST /api/v1/installs: how the listener app gets its install token. Listeners are anonymous, so
 * this needs no sign-in, cookie or token. Installs cost nothing to make, so first registrations are
 * limited strictly per address. A phone also registers again whenever its app version changes, so
 * after a release many phones behind one carrier address do so within the hour: a registration that
 * carries the install's own valid token is counted against that install instead, a few a day (A3,
 * P4 design §5.7). The header is never required, and the answer is the same either way.
 */
@Controller('installs')
@PublicRoute()
export class ListenerInstallsController {
  private readonly registrationsPerAddress: RateLimitRule;
  private readonly reregistrationsPerInstall: RateLimitRule;

  constructor(
    private readonly listenerInstalls: ListenerInstallsService,
    private readonly rateLimiter: RateLimiter,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.registrationsPerAddress = {
      counterName: 'install-registrations-per-address',
      maximumRequests: config.LISTENER_REGISTRATIONS_PER_CLIENT_ADDRESS_PER_HOUR,
      windowSeconds: 60 * 60,
    };
    this.reregistrationsPerInstall = {
      counterName: 'install-reregistrations-per-install',
      maximumRequests: config.LISTENER_REREGISTRATIONS_PER_INSTALL_PER_DAY,
      windowSeconds: 24 * 60 * 60,
    };
  }

  @Post()
  @HttpCode(200)
  async register(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body(new ZodValidationPipe(RegisterInstallInput)) input: RegisterInstallInput,
  ): Promise<InstallRegistration> {
    const reregisteringInstallId = await this.listenerInstalls.findReregisteringInstall(request.headers.authorization, input.install_id);
    if (reregisteringInstallId) await this.rateLimiter.countRequest(this.reregistrationsPerInstall, reregisteringInstallId, response);
    else await this.rateLimiter.countRequest(this.registrationsPerAddress, request.ip ?? 'unknown', response);
    return this.listenerInstalls.register(input);
  }
}
