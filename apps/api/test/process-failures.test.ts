import { type ChildProcess, spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const API_DIRECTORY = resolve(import.meta.dirname, '..');
const TYPESCRIPT_LOADER = './test/support/typescript-loader/register.mjs';
// Each child compiles the API's TypeScript on start; on the slow build machine that takes a while.
const CHILD_PROCESS_TIMEOUT_MILLISECONDS = 120_000;

interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a TypeScript entry point in its own Node process and collects what it prints. With
 * `stopWhen`, the process is stopped as soon as its output satisfies the condition.
 */
function runNodeProcess(
  entryPoint: string,
  options: { arguments?: string[]; environment?: NodeJS.ProcessEnv; stopWhen?: (stdout: string) => boolean } = {},
): Promise<ProcessResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child: ChildProcess = spawn(process.execPath, ['--import', TYPESCRIPT_LOADER, entryPoint, ...(options.arguments ?? [])], {
      cwd: API_DIRECTORY,
      env: { ...process.env, ...options.environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error(`process did not finish in time; stdout so far:\n${stdout}\nstderr:\n${stderr}`));
    }, CHILD_PROCESS_TIMEOUT_MILLISECONDS - 5_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (options.stopWhen?.(stdout)) child.kill();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', rejectPromise);
    child.on('exit', (exitCode) => {
      clearTimeout(timer);
      resolvePromise({ exitCode, stdout, stderr });
    });
  });
}

/** Every line printed must be one JSON object, so the platform's log search can read all of it. */
function parseJsonLines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        throw new Error(`a line that is not JSON reached stdout: ${line.slice(0, 200)}`);
      }
    });
}

function databasePassword(): string {
  return decodeURIComponent(new URL(process.env.DATABASE_URL as string).password);
}

describe('process failures are logged as one structured line, then the process exits', () => {
  it(
    'an unreachable database at start-up: one fatal JSON line with the stack, no password, nothing else, exit 1',
    async () => {
      const unreachableDatabaseUrl = new URL(process.env.DATABASE_URL as string);
      unreachableDatabaseUrl.hostname = '127.0.0.1';
      unreachableDatabaseUrl.port = '1';

      const result = await runNodeProcess('src/main.ts', { environment: { DATABASE_URL: unreachableDatabaseUrl.toString() } });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe('');
      const lines = parseJsonLines(result.stdout);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ level: 60, service: 'lookup-api', event: 'startup', msg: 'process failure' });
      expect(String((lines[0]?.err as { stack?: string }).stack)).toMatch(/ECONNREFUSED[\s\S]*\n\s+at /);
      expect(result.stdout).not.toContain(databasePassword());
    },
    CHILD_PROCESS_TIMEOUT_MILLISECONDS,
  );

  it(
    'a normal start writes only JSON lines, including the messages Nest printed while starting',
    async () => {
      const port = String(41_000 + randomInt(1_000));
      const result = await runNodeProcess('src/main.ts', {
        environment: { PORT: port },
        stopWhen: (stdout) => stdout.includes('Nest application successfully started'),
      });

      const lines = parseJsonLines(result.stdout);
      expect(lines.some((line) => String(line.msg).includes('Nest application successfully started'))).toBe(true);
      expect(lines.some((line) => String(line.msg).includes('dependencies initialized'))).toBe(true);
      expect(result.stderr).toBe('');
    },
    CHILD_PROCESS_TIMEOUT_MILLISECONDS,
  );

  it.each([
    ['unhandled-rejection', 'unhandledRejection', 'nobody awaited the lookup for [email]'],
    ['uncaught-exception', 'uncaughtException', 'nothing caught the failure for [email]'],
  ])(
    'an %s: one fatal JSON line with the stack and personal values masked, exit 1',
    async (failure, event, expectedMessage) => {
      const result = await runNodeProcess('test/support/process-failure-entry.ts', { arguments: [failure] });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe('');
      const lines = parseJsonLines(result.stdout);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ level: 60, event, err: { message: expectedMessage } });
      expect(String((lines[0]?.err as { stack?: string }).stack)).toContain('process-failure-entry.ts');
      expect(result.stdout).not.toContain('chanda.mwale@example.test');
    },
    CHILD_PROCESS_TIMEOUT_MILLISECONDS,
  );
});
