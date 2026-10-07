import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Local runs read apps/api/.env; CI provides real environment variables (which take precedence,
// because loadEnvFile never overwrites a variable that is already set).
const environmentFile = resolve(import.meta.dirname, '..', '..', '.env');
if (existsSync(environmentFile)) process.loadEnvFile(environmentFile);
process.env.NODE_ENV = 'test';

// Every test file gets its own queue prefix in Valkey, so tests never take jobs from the development
// workers' queues or from each other, and the background ingest sweep stays off unless a test runs it.
process.env.QUEUE_KEY_PREFIX = `lookup-test-${randomBytes(4).toString('hex')}`;
process.env.INGEST_SWEEP_INTERVAL_SECONDS = '0';
