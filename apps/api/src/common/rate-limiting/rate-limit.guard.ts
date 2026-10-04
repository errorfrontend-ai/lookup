import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { RATE_LIMIT_RULE_METADATA } from './rate-limit.decorator.js';
import type { RateLimitRule } from './rate-limit-rule.js';
import { RateLimiter } from './rate-limiter.js';

/** Applies @RateLimit rules on the routes and controllers that declare them. */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimiter: RateLimiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rule = this.reflector.getAllAndOverride<RateLimitRule | undefined>(RATE_LIMIT_RULE_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!rule || context.getType() !== 'http') return true;
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    await this.rateLimiter.countRequest(rule, request.ip ?? 'unknown', http.getResponse<Response>());
    return true;
  }
}
