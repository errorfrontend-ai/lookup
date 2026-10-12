import { randomUUID } from 'node:crypto';

type LogFields = Record<string, unknown>;

/** What a job logs through: nestjs-pino's PinoLogger, or anything with the same three methods. */
export interface JobLogger {
  info(fields: LogFields, message: string): void;
  warn(fields: LogFields, message: string): void;
  error(fields: LogFields, message: string): void;
}

/** One run of a job: its own request id, and a logger that puts the id and the job's name on every line. */
export interface JobRun {
  requestId: string;
  logger: JobLogger;
}

/**
 * Runs one turn of a scheduled job (ALL-JOBS-01, -02; P4 design §5.12). The run gets a fresh request id, and every
 * line it logs carries that id and the job's name, so one search finds the whole run. A failure is caught and
 * logged with its stack under the same id, never thrown: the caller's next run still happens. Resolves to the
 * job's result, or undefined when it failed.
 */
export async function runJob<Result>(logger: JobLogger, jobName: string, work: (run: JobRun) => Promise<Result>): Promise<Result | undefined> {
  const requestId = `${jobName}-${randomUUID()}`;
  const tagged = (fields: LogFields): LogFields => ({ ...fields, job: jobName, requestId });
  const runLogger: JobLogger = {
    info: (fields, message) => logger.info(tagged(fields), message),
    warn: (fields, message) => logger.warn(tagged(fields), message),
    error: (fields, message) => logger.error(tagged(fields), message),
  };
  try {
    return await work({ requestId, logger: runLogger });
  } catch (error) {
    logger.error(tagged({ err: error }), `the scheduled job ${jobName} failed; it will retry at its next run`);
    return undefined;
  }
}

/**
 * Runs a job every `intervalMilliseconds`, each turn through runJob, so a failed turn never stops the next one. The
 * timer does not keep the process alive. Returns the function that stops it.
 */
export function repeatJob<Result>(logger: JobLogger, jobName: string, intervalMilliseconds: number, work: (run: JobRun) => Promise<Result>): () => void {
  const timer = setInterval(() => void runJob(logger, jobName, work), intervalMilliseconds);
  timer.unref();
  return () => clearInterval(timer);
}
