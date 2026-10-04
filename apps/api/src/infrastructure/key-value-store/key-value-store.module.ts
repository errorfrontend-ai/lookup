import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';

/** Dependency-injection token for the shared key-value store connection. */
export const KEY_VALUE_STORE = Symbol('KEY_VALUE_STORE');

/**
 * One shared Valkey connection for request-path work (health, rate limits, worker heartbeats).
 * It fails fast instead of queueing commands while disconnected, so a dead store shows up as a
 * quick answer rather than a hung request.
 */
@Global()
@Module({
  providers: [
    {
      provide: KEY_VALUE_STORE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new Redis(config.KEY_VALUE_STORE_URL, {
          lazyConnect: false,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          connectTimeout: 3_000,
        }),
    },
  ],
  exports: [KEY_VALUE_STORE],
})
export class KeyValueStoreModule implements OnApplicationShutdown {
  constructor(@Inject(KEY_VALUE_STORE) private readonly keyValueStore: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.keyValueStore.quit().catch(() => this.keyValueStore.disconnect());
  }
}
