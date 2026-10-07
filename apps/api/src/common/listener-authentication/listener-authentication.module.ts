import { Global, Module } from '@nestjs/common';
import { InstallTokenGuard } from './install-token.guard.js';
import { InstallTokens } from './install-tokens.js';

/** Install tokens and the guard on the listener routes, shared by the installs and recognition features. */
@Global()
@Module({
  providers: [InstallTokens, InstallTokenGuard],
  exports: [InstallTokens, InstallTokenGuard],
})
export class ListenerAuthenticationModule {}
