import 'reflect-metadata';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Redis } from 'ioredis';
import { Logger } from 'nestjs-pino';
import { AppModule } from '../../src/app.module.js';
import { APP_CONFIG, type AppConfig } from '../../src/config/app-config.js';
import { LOG_DESTINATION } from '../../src/config/config.module.js';
import { configureHttpApplication } from '../../src/configure-http-application.js';
import { KEY_VALUE_STORE } from '../../src/infrastructure/key-value-store/key-value-store.module.js';
import { LogCapture } from './log-capture.js';

export interface TestApplication {
  application: NestExpressApplication;
  logs: LogCapture;
  close: () => Promise<void>;
}

/**
 * Build the real application (same HTTP setup as main.ts) with optional test modules and
 * provider overrides. Create at most one per test file: nestjs-pino keeps a single pino-http
 * instance per process, so a second application would write its logs into the first one's capture.
 */
export async function createTestApplication(
  options: { extraModules?: unknown[]; overrideProviders?: (builder: TestingModuleBuilder) => TestingModuleBuilder } = {},
): Promise<TestApplication> {
  const logs = new LogCapture();
  let builder = Test.createTestingModule({ imports: [AppModule, ...((options.extraModules ?? []) as never[])] })
    .overrideProvider(LOG_DESTINATION)
    .useValue(logs);
  if (options.overrideProviders) builder = options.overrideProviders(builder);
  const testingModule = await builder.compile();
  const application = testingModule.createNestApplication<NestExpressApplication>({ bodyParser: false, bufferLogs: true });
  application.useLogger(application.get(Logger));
  configureHttpApplication(application, application.get<AppConfig>(APP_CONFIG));
  await application.init();
  const close = async () => {
    await removeTestQueueKeys(application.get<Redis>(KEY_VALUE_STORE), application.get<AppConfig>(APP_CONFIG).QUEUE_KEY_PREFIX);
    await application.close();
  };
  return { application, logs, close };
}

/** Removes everything this test file put in Valkey under its own queue prefix (jobs, events, heartbeats). */
export async function removeTestQueueKeys(keyValueStore: Redis, queueKeyPrefix: string): Promise<void> {
  // Some tests stand in a broken or fake store; there is then nothing of ours in Valkey to remove.
  if (!queueKeyPrefix.startsWith('lookup-test-') || typeof keyValueStore.scan !== 'function') return;
  try {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await keyValueStore.scan(cursor, 'MATCH', `${queueKeyPrefix}:*`, 'COUNT', 500);
      if (keys.length > 0) await keyValueStore.del(...keys);
      cursor = nextCursor;
    } while (cursor !== '0');
  } catch {
    // The store is down in this test; its keys expire or are removed by the next clean run.
  }
}
