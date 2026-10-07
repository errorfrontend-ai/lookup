// Runs the two fingerprint workers (services/fingerprinter/workers) on this computer, against the same
// Valkey and Postgres the API uses (settings from apps/api/.env), so uploaded ads become Ready and the
// listener app's clips are matched:  npm run workers
//
// Each worker gets only what it needs: the Valkey address, its own database role
// (lookup_fingerprint_worker) and the queue prefix. No storage credentials: it downloads through the
// short-lived address in each job. Ctrl+C stops both, with their pool processes.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const apiSettingsFile = join(repositoryRoot, 'apps', 'api', '.env');
const fingerprinterDirectory = join(repositoryRoot, 'services', 'fingerprinter');
const python = process.platform === 'win32' ? join(fingerprinterDirectory, '.venv', 'Scripts', 'python.exe') : join(fingerprinterDirectory, '.venv', 'bin', 'python');

if (!existsSync(apiSettingsFile)) throw new Error('apps/api/.env is missing: copy apps/api/.env.example and fill it in first.');
if (!existsSync(python)) {
  throw new Error('The fingerprinter has no Python environment yet: cd services/fingerprinter; python -m venv .venv; then install it with: .venv/Scripts/python -m pip install -e ".[postgres,worker]"');
}
process.loadEnvFile(apiSettingsFile);

const databaseAddress = new URL(process.env.DATABASE_URL);
databaseAddress.username = 'lookup_fingerprint_worker';
databaseAddress.password = encodeURIComponent(process.env.LOOKUP_FINGERPRINT_WORKER_DATABASE_PASSWORD ?? '');

const keep = ['PATH', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP'];
const workerEnvironment = {
  ...Object.fromEntries(keep.filter((name) => process.env[name]).map((name) => [name, process.env[name]])),
  PYTHONIOENCODING: 'utf-8',
  PYTHONUNBUFFERED: '1',
  KEY_VALUE_STORE_URL: process.env.KEY_VALUE_STORE_URL,
  FINGERPRINT_DATABASE_URL: databaseAddress.toString(),
  QUEUE_KEY_PREFIX: process.env.QUEUE_KEY_PREFIX ?? 'lookup',
  // Two jobs at once per worker, as in production. On a computer short of memory: WORKER_CONCURRENCY=1 npm run workers
  WORKER_CONCURRENCY: process.env.WORKER_CONCURRENCY ?? '2',
  LOG_LEVEL: 'INFO',
};

const workers = ['ingest', 'recognize'].map((queueName) => {
  const child = spawn(python, ['-m', `workers.${queueName}`], { cwd: fingerprinterDirectory, env: workerEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      for (const line of chunk.toString('utf8').split('\n').filter((text) => text.trim())) console.log(`[${queueName}] ${line}`);
    });
  }
  child.on('exit', (code) => console.log(`[${queueName}] stopped (exit code ${code})`));
  return child;
});

const stopAll = () => {
  for (const child of workers) {
    if (child.exitCode !== null || child.pid === undefined) continue;
    if (process.platform === 'win32') {
      try {
        execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        // already stopped
      }
    } else {
      child.kill('SIGTERM');
    }
  }
};
process.on('SIGINT', () => {
  stopAll();
  process.exit(0);
});
process.on('SIGTERM', () => {
  stopAll();
  process.exit(0);
});
