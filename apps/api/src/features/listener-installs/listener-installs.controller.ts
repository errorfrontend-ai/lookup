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
 * this needs no sign-in, cookie or token. Installs cost nothing to make, so registrations are limited
 * strictly per address (a phone registers once, and again only when its token runs out).
 */
@Controller('installs')
@PublicRoute()
export class ListenerInstallsController {
  private readonly registrationsPerAddress: RateLimitRule;

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
  }

  @Post()
  @HttpCode(200)
  async register(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body(new ZodValidationPipe(RegisterInstallInput)) input: RegisterInstallInput,
  ): Promise<InstallRegistration> {
    await this.rateLimiter.countRequest(this.registrationsPerAddress, request.ip ?? 'unknown', response);
    return this.listenerInstalls.register(input);
  }
}
