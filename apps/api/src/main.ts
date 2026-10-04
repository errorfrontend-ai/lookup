import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { pino } from 'pino';
import { AppModule } from './app.module.js';
import { APP_CONFIG, type AppConfig } from './config/app-config.js';
import { configureHttpApplication } from './configure-http-application.js';

// Last-resort logger for failures outside any request (startup, unhandled rejections).
const processLogger = pino({ base: { service: 'lookup-api' } });

function logFatalAndExit(event: string, error: unknown): never {
  processLogger.fatal({ err: error instanceof Error ? error : new Error(String(error)), event }, 'process failure');
  process.exit(1);
}

process.on('unhandledRejection', (reason) => logFatalAndExit('unhandledRejection', reason));
process.on('uncaughtException', (error) => logFatalAndExit('uncaughtException', error));

async function startServer(): Promise<void> {
  const application = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, bodyParser: false });
  application.useLogger(application.get(Logger));
  const config = application.get<AppConfig>(APP_CONFIG);
  configureHttpApplication(application, config);
  application.enableShutdownHooks();
  await application.listen(config.PORT);
}

startServer().catch((error: unknown) => logFatalAndExit('startup', error));
