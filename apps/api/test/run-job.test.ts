import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serializeErrorForLog } from '../src/infrastructure/logging/serialize-error-for-log.js';
import { repeatJob, runJob } from '../src/infrastructure/scheduled-jobs/run-job.js';
import { LogCapture, waitForLogWrites } from './support/log-capture.js';

/** The wrapper every scheduled job runs through (P4 design §5.12; ALL-JOBS-01, -02). */
describe('scheduled jobs', () => {
  afterEach(() => vi.useRealTimers());

  /** A logger like the API's: JSON lines, errors written by the API's own serializer. */
  function capturedLogger() {
    const capture = new LogCapture();
    return { capture, logger: pino({ level: 'info', serializers: { err: serializeErrorForLog } }, capture) };
  }

  it('a run’s lines all carry one fresh request id and the job’s name, and the next run gets another id', async () => {
    const { capture, logger } = capturedLogger();
    const results = [];
    for (let turn = 0; turn < 2; turn += 1) {
      results.push(
        await runJob(logger, 'partition-top-up', async (run) => {
          run.logger.info({ step: 'first' }, 'looked');
          run.logger.warn({ step: 'second' }, 'found something odd');
          return run.requestId;
        }),
      );
    }
    await waitForLogWrites();
    expect(capture.lines).toHaveLength(4);
    for (const line of capture.lines) expect(line.job).toBe('partition-top-up');
    const [firstRun, secondRun] = results;
    expect(firstRun).toMatch(/^partition-top-up-[0-9a-f-]{36}$/);
    expect(secondRun).not.toBe(firstRun);
    expect(capture.lines.map((line) => line.requestId)).toEqual([firstRun, firstRun, secondRun, secondRun]);
  });

  it('a job that throws is logged once at error level, with its stack and the run’s id, and the call resolves instead of throwing', async () => {
    const { capture, logger } = capturedLogger();
    let runRequestId = '';
    const outcome = await runJob(logger, 'idempotency-key-clean-up', async (run) => {
      runRequestId = run.requestId;
      throw new TypeError("Cannot read properties of undefined (reading 'rows')");
    });
    await waitForLogWrites();
    expect(outcome).toBeUndefined();
    const errorLines = capture.lines.filter((line) => line.level === 50);
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toMatchObject({ job: 'idempotency-key-clean-up', requestId: runRequestId, msg: expect.stringContaining('will retry') });
    expect((errorLines[0]?.err as { stack?: string }).stack).toMatch(/^TypeError: Cannot read properties[^]*\n\s+at /);
  });

  it('a repeated job runs again at its next time after a run that failed, and stops when told', async () => {
    vi.useFakeTimers();
    const { logger } = capturedLogger();
    const errorSpy = vi.spyOn(logger, 'error');
    let runs = 0;
    const stop = repeatJob(logger, 'partition-top-up', 60_000, async () => {
      runs += 1;
      if (runs === 1) throw new Error('the database is restarting');
      return runs;
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs).toBe(2);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    stop();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(runs).toBe(2);
  });
});
