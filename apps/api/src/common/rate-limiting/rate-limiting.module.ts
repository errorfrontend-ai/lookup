import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { RateLimitGuard } from './rate-limit.guard.js';
import { RateLimiter } from './rate-limiter.js';

@Global()
@Module({
  providers: [RateLimiter, { provide: APP_GUARD, useClass: RateLimitGuard }],
  exports: [RateLimiter],
})
export class RateLimitingModule {}
