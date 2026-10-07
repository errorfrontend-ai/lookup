import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

// The seeded owner's sign-in and the database address for clean-up come from the API's .env, the same
// file the seed script reads. Nothing secret is written in this repository.
const apiEnvironmentFile = fileURLToPath(new URL('../api/.env', import.meta.url));
if (existsSync(apiEnvironmentFile)) process.loadEnvFile(apiEnvironmentFile);

/**
 * Browser journeys against the real stack (Docker services, the API and the portal), in the Chrome
 * installed on this computer (no browser is downloaded), once as a phone and once on a desktop.
 *   npm run test:end-to-end --workspace=@lookup/portal
 * The Docker services must be running; the API and the portal are started if they are not already.
 */
export default defineConfig({
  testDir: './e2e',
  // One seeded station is shared, and the build machine is small: one browser at a time.
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  globalTeardown: './e2e/support/remove-browser-test-ads.ts',
  use: {
    baseURL: 'http://localhost:5180',
    channel: 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'phone', use: { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
    { name: 'desktop', use: { viewport: { width: 1280, height: 900 } } },
  ],
  webServer: [
    { command: 'npm run start:watch', cwd: '../api', url: 'http://localhost:3100/api/v1/health', reuseExistingServer: true, timeout: 180_000 },
    { command: 'npm run dev', url: 'http://localhost:5180', reuseExistingServer: true, timeout: 180_000 },
  ],
});
