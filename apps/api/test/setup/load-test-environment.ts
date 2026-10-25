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
// No test application sends notifications unless its test turns the worker on (notifications.test.ts does).
process.env.NOTIFICATION_SENDING_ENABLED = 'false';
// Nor does any send air-time reminders on its own: air-time-reminders.test.ts runs the job by hand.
process.env.AIR_TIME_REMINDER_INTERVAL_SECONDS = '0';
// Push is off unless a test turns it on (a development key pair in .env must not change what the tests see).
process.env.WEB_PUSH_PUBLIC_KEY = '';
process.env.WEB_PUSH_PRIVATE_KEY = '';
process.env.WEB_PUSH_CONTACT_EMAIL = '';
