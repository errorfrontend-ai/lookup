import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { APP_CONFIG, type AppConfig } from './config/app-config.js';
import { configureHttpApplication } from './configure-http-application.js';
import { installProcessFailureHandlers, logFatalAndExit } from './process-failures.js';

installProcessFailureHandlers();

async function startServer(): Promise<void> {
  // Start-up messages wait in a buffer until the JSON logger takes over. If start-up fails (bad
  // configuration, unreachable database), abortOnError: false hands the failure to us, it is logged
  // as one JSON line with the stack, and the buffered text is never printed (autoFlushLogs: false).
  const application = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    autoFlushLogs: false,
    bodyParser: false,
    abortOnError: false,
  });
  application.useLogger(application.get(Logger));
  application.flushLogs();
  const config = application.get<AppConfig>(APP_CONFIG);
  configureHttpApplication(application, config);
  application.enableShutdownHooks();
  await application.listen(config.PORT);
}

startServer().catch((error: unknown) => logFatalAndExit('startup', error));
