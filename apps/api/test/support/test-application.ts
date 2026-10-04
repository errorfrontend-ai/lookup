import 'reflect-metadata';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from '../../src/app.module.js';
import { APP_CONFIG, type AppConfig } from '../../src/config/app-config.js';
import { LOG_DESTINATION } from '../../src/config/config.module.js';
import { configureHttpApplication } from '../../src/configure-http-application.js';
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
  return { application, logs, close: () => application.close() };
}
