import { ChangePasswordInput, type SignedInPortalUser, SignInInput } from '@lookup/contracts';
import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { RateLimit } from '../../common/rate-limiting/rate-limit.decorator.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { REFRESH_REQUESTS_PER_ADDRESS, SIGN_IN_REQUESTS_PER_ADDRESS } from './authentication-rate-limits.js';
import { AuthenticationService, type RequestFacts } from './authentication.service.js';
import { PublicRoute } from './public-route.decorator.js';
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE, TRUSTED_DEVICE_COOKIE } from './session-cookies.js';

/**
 * Portal sign-in. Tokens travel only in HttpOnly cookies, never in response bodies or URLs. Every
 * route here requires an allowed Origin, even without cookies (see rejectCrossSiteCookieRequests),
 * which stops another site from signing a browser in to an attacker's account.
 */
@Controller('auth')
export class AuthenticationController {
  constructor(
    private readonly authenticationService: AuthenticationService,
    private readonly requestContext: ClsService,
  ) {}

  @Post('sign-in')
  @PublicRoute()
  @RateLimit(SIGN_IN_REQUESTS_PER_ADDRESS)
  @HttpCode(200)
  signIn(
    @Body(new ZodValidationPipe(SignInInput)) input: SignInInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SignedInPortalUser> {
    return this.authenticationService.signIn(input, request.cookies?.[TRUSTED_DEVICE_COOKIE], requestFacts(request), response);
  }

  @Post('refresh')
  @PublicRoute()
  @RateLimit(REFRESH_REQUESTS_PER_ADDRESS)
  @HttpCode(204)
  async refresh(@Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<void> {
    await this.authenticationService.refresh(request.cookies?.[REFRESH_TOKEN_COOKIE], requestFacts(request), response);
  }

  @Post('sign-out')
  @PublicRoute()
  @HttpCode(204)
  async signOut(@Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<void> {
    await this.authenticationService.signOut(
      request.cookies?.[ACCESS_TOKEN_COOKIE],
      request.cookies?.[REFRESH_TOKEN_COOKIE],
      requestFacts(request),
      response,
    );
  }

  @Post('change-password')
  @HttpCode(204)
  async changePassword(
    @Body(new ZodValidationPipe(ChangePasswordInput)) input: ChangePasswordInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.authenticationService.changePassword(input, requestFacts(request), response);
  }

  @Get('me')
  me(): Promise<SignedInPortalUser> {
    return this.authenticationService.describeSignedInUser(this.requestContext.get<string>('userId'));
  }
}

function requestFacts(request: Request): RequestFacts {
  return { requestId: (request as Request & { id?: string }).id ?? 'unknown', clientAddress: request.ip ?? 'unknown' };
}
