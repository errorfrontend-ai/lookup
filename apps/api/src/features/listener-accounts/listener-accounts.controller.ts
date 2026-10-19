import {
  CreateListenerAccountInput,
  type ListenerAccountCodeSent,
  type ListenerAccountSignedIn,
  type ListenerAccountSummary,
  RequestListenerAccountCodeInput,
  VerifyListenerAccountCodeInput,
  type VerifyListenerAccountCodeAnswer,
} from '@lookup/contracts';
import { Body, Controller, Delete, Get, HttpCode, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { InstallTokenGuard } from '../../common/listener-authentication/install-token.guard.js';
import { ListenerFollowUpLimitGuard } from '../../common/rate-limiting/listener-follow-up-limits.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { PublicRoute } from '../authentication/public-route.decorator.js';
import { ListenerAccountsService } from './listener-accounts.service.js';

/**
 * The listener's account (ADR-005, docs/design/listener-accounts.md §4). Every route is for the listener app, so it
 * needs an install token (401 before anything else), then the update gate, then the follow-up allowance every
 * listener follow-up shares (a code, a check and a creation also have allowances of their own, counted in the
 * service), then a strict body. A portal cookie opens none of them, and a cookie-carrying request from another site
 * is refused before it gets here.
 */
@Controller('listener-account')
@PublicRoute()
@UseGuards(InstallTokenGuard, ListenerFollowUpLimitGuard)
export class ListenerAccountsController {
  constructor(private readonly listenerAccountsService: ListenerAccountsService) {}

  @Post('code')
  @HttpCode(202)
  requestCode(
    @Body(new ZodValidationPipe(RequestListenerAccountCodeInput)) input: RequestListenerAccountCodeInput,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ListenerAccountCodeSent> {
    return this.listenerAccountsService.requestCode(input.email, response);
  }

  @Post('verify')
  @HttpCode(200)
  verifyCode(
    @Body(new ZodValidationPipe(VerifyListenerAccountCodeInput)) input: VerifyListenerAccountCodeInput,
    @Res({ passthrough: true }) response: Response,
  ): Promise<VerifyListenerAccountCodeAnswer> {
    return this.listenerAccountsService.verifyCode(input.email, input.code, response);
  }

  @Post()
  @HttpCode(201)
  createAccount(
    @Body(new ZodValidationPipe(CreateListenerAccountInput)) input: CreateListenerAccountInput,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ListenerAccountSignedIn> {
    return this.listenerAccountsService.createAccount(input, response);
  }

  @Get()
  describe(): Promise<ListenerAccountSummary> {
    return this.listenerAccountsService.describe();
  }

  @Post('sign-out')
  @HttpCode(204)
  async signOut(): Promise<void> {
    await this.listenerAccountsService.signOut();
  }

  @Delete()
  @HttpCode(204)
  async deleteAccount(): Promise<void> {
    await this.listenerAccountsService.deleteAccount();
  }
}
