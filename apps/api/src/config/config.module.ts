import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, loadAppConfig } from './app-config.js';

/** Where structured logs go: stdout in every environment (the platform captures it); tests swap in a memory stream. */
export const LOG_DESTINATION = Symbol('LOG_DESTINATION');

@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadAppConfig() },
    { provide: LOG_DESTINATION, useValue: process.stdout },
  ],
  exports: [APP_CONFIG, LOG_DESTINATION],
})
export class ConfigModule {}
