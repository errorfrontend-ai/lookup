import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccessTokens } from './access-tokens.js';
import { AuthenticationController } from './authentication.controller.js';
import { AuthenticationService } from './authentication.service.js';
import { PasswordHasher } from './password-hasher.js';
import { PasswordPolicy } from './password-policy.js';
import { SignedInGuard } from './signed-in.guard.js';
import { TrustedDevices } from './trusted-devices.js';

@Module({
  controllers: [AuthenticationController],
  providers: [
    AuthenticationService,
    AccessTokens,
    PasswordHasher,
    PasswordPolicy,
    TrustedDevices,
    // Every route needs a signed-in user unless marked @PublicRoute().
    { provide: APP_GUARD, useClass: SignedInGuard },
  ],
  exports: [AuthenticationService, PasswordHasher, PasswordPolicy],
})
export class AuthenticationModule {}
