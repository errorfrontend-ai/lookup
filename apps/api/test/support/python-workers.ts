import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Redis } from 'ioredis';
import { workerHeartbeatKey } from '../../src/infrastructure/job-queues/worker-heartbeat-key.js';

export const FINGERPRINTER_DIRECTORY = resolve(import.meta.dirname, '..', '..', '..', '..', 'services', 'fingerprinter');

/** The fingerprinter's own Python. Missing means the setup step was skipped: the tests fail, they never skip. */
export function fingerprinterPython(): string {
  const python = process.platform === 'win32' ? join(FINGERPRINTER_DIRECTORY, '.venv', 'Scripts', 'python.exe') : join(FINGERPRINTER_DIRECTORY, '.venv', 'bin', 'python');
  if (!existsSync(python)) {
    throw new Error(`No Python environment for the fingerprinter at ${python}. Create it: cd services/fingerprinter; python -m venv .venv; .venv\\Scripts\\python -m pip install -e ".[postgres,worker,dev]"`);
  }
  return python;
}

/** The worker's database address: the API's own server, as lookup_fingerprint_worker. */
export function fingerprintWorkerDatabaseUrl(): string {
  const address = new URL(process.env.DATABASE_URL as string);
  address.username = 'lookup_fingerprint_worker';
  address.password = encodeURIComponent(process.env.LOOKUP_FINGERPRINT_WORKER_DATABASE_PASSWORD ?? '');
  return address.toString();
}

/** Runs a command of the fingerprinter's Python package (e.g. bench.make_test_audio) and waits for it. */
export function runFingerprinterModule(moduleName: string, moduleArguments: string[]): void {
  execFileSync(fingerprinterPython(), ['-m', moduleName, ...moduleArguments], {
    cwd: FINGERPRINTER_DIRECTORY,
    env: { ...minimalEnvironment(), PYTHONIOENCODING: 'utf-8' },
    stdio: 'pipe',
    timeout: 300_000,
  });
}

function minimalEnvironment(): Record<string, string> {
  // Only what Python itself needs to start: nothing of the API's settings, so no storage credentials.
  const keep = ['PATH', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA'];
  return Object.fromEntries(keep.filter((name) => process.env[name]).map((name) => [name, process.env[name] as string]));
}

export interface PythonWorker {
  queueName: 'recognize' | 'ingest';
  /** Every JSON line the worker wrote, parsed. */
  logLines: Array<Record<string, unknown>>;
  /** Its own temporary folder, which must stay empty (clips never touch the disk). */
  temporaryDirectory: string;
  stop: () => Promise<void>;
}

/** Starts `python -m workers.<queue>` against the compose Valkey and Postgres and waits for its heartbeat. */
export async function startPythonWorker(queueName: 'recognize' | 'ingest', options: { queueKeyPrefix: string; concurrency?: number }): Promise<PythonWorker> {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), `lookup-${queueName}-worker-`));
  const child: ChildProcess = spawn(fingerprinterPython(), ['-m', `workers.${queueName}`], {
    cwd: FINGERPRINTER_DIRECTORY,
    env: {
      ...minimalEnvironment(),
      TEMP: temporaryDirectory,
      TMP: temporaryDirectory,
      TMPDIR: temporaryDirectory,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
      KEY_VALUE_STORE_URL: process.env.KEY_VALUE_STORE_URL as string,
      FINGERPRINT_DATABASE_URL: fingerprintWorkerDatabaseUrl(),
      QUEUE_KEY_PREFIX: options.queueKeyPrefix,
      WORKER_CONCURRENCY: String(options.concurrency ?? 1),
      LOG_LEVEL: 'INFO',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logLines: Array<Record<string, unknown>> = [];
  const rawOutput: string[] = [];
  let pending = '';
  const collect = (chunk: Buffer) => {
    pending += chunk.toString('utf8');
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines.filter((text) => text.trim())) {
      rawOutput.push(line);
      try {
        logLines.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        logLines.push({ unparsed: line });
      }
    }
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  let hasExited = false;
  child.on('exit', () => (hasExited = true));

  const stop = async () => {
    if (hasExited || child.pid === undefined) return;
    // The worker's pool processes are its children: stop the whole tree.
    if (process.platform === 'win32') {
      try {
        execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        // already gone
      }
    } else {
      child.kill('SIGKILL');
    }
    await new Promise<void>((done) => (hasExited ? done() : child.once('exit', () => done())));
  };

  const keyValueStore = new Redis(process.env.KEY_VALUE_STORE_URL as string);
  try {
    const startedAt = Date.now();
    while (!(await keyValueStore.exists(workerHeartbeatKey(options.queueKeyPrefix, queueName)))) {
      if (hasExited) throw new Error(`the ${queueName} worker stopped while starting:\n${rawOutput.slice(-20).join('\n')}`);
      if (Date.now() - startedAt > 120_000) {
        await stop();
        throw new Error(`the ${queueName} worker did not start within 2 minutes:\n${rawOutput.slice(-20).join('\n')}`);
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
  } finally {
    await keyValueStore.quit();
  }
  return { queueName, logLines, temporaryDirectory, stop };
}
