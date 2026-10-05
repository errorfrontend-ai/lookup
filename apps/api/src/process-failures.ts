import { pino } from 'pino';
import { serializeErrorForLog } from './infrastructure/logging/serialize-error-for-log.js';

/**
 * Last-resort logger for failures outside any request (start-up, unhandled rejections, uncaught
 * exceptions). Same JSON shape, service name and error cleaning as the request logs.
 */
export const processLogger = pino({ base: { service: 'lookup-api' }, serializers: { err: serializeErrorForLog } });

/** One structured fatal line with the stack, then exit, so the platform restarts a clean process. */
export function logFatalAndExit(event: string, error: unknown): never {
  processLogger.fatal({ err: error, event }, 'process failure');
  process.exit(1);
}

/** A rejection nobody handled, or an exception nothing caught, leaves the process in an unknown state. */
export function installProcessFailureHandlers(): void {
  process.on('unhandledRejection', (reason) => logFatalAndExit('unhandledRejection', reason));
  process.on('uncaughtException', (error) => logFatalAndExit('uncaughtException', error));
}
