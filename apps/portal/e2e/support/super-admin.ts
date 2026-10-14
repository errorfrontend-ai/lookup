import { computeTwoFactorCode, decodeBase32, twoFactorTimeStepAt } from '@lookup/contracts';
import { expect, type Page } from '@playwright/test';
import pg from 'pg';
import { cleanUpIsAllowed } from './remove-browser-test-ads';

/**
 * The step to use for the next code. The API takes each 30-second step once, and one step either side of now, so
 * two sign-ins close together need different steps: this reads the last one used and takes the next, waiting only
 * when both steps around now are spent. It reads the database directly (development on this computer only).
 */
async function nextUnusedTimeStep(email: string): Promise<number> {
  const connectionString = process.env.DATABASE_SETUP_URL ?? '';
  if (!cleanUpIsAllowed(connectionString, process.env.NODE_ENV)) {
    throw new Error('The super admin journeys run only against a development database on this computer (DATABASE_SETUP_URL).');
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  let lastUsed: number | null;
  try {
    const found = await client.query<{ step: string | null }>('SELECT two_factor_last_used_time_step AS step FROM app.portal_users WHERE email = $1', [email]);
    lastUsed = found.rows[0]?.step == null ? null : Number(found.rows[0].step);
  } finally {
    await client.end();
  }
  for (;;) {
    const now = twoFactorTimeStepAt(Date.now());
    const step = lastUsed === null || lastUsed < now ? now : lastUsed + 1;
    if (step <= now + 1) return step;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

function seededSuperAdmin(): { email: string; password: string; secret: Uint8Array } {
  const email = process.env.SEED_SUPER_ADMIN_EMAIL;
  const password = process.env.SEED_SUPER_ADMIN_PASSWORD;
  const secret = decodeBase32(process.env.SEED_SUPER_ADMIN_TWO_FACTOR_SECRET ?? '');
  if (!email || !password || !secret) {
    throw new Error('SEED_SUPER_ADMIN_EMAIL, SEED_SUPER_ADMIN_PASSWORD and SEED_SUPER_ADMIN_TWO_FACTOR_SECRET must be set in apps/api/.env (then run npm run database:seed).');
  }
  return { email, password, secret };
}

/** The super admin's email and password; ends on the page that asks for the code. */
export async function signInSuperAdminPassword(page: Page): Promise<void> {
  const { email, password } = seededSuperAdmin();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Enter the 6-digit code from your authenticator app' })).toBeVisible();
}

/** The code from the seeded secret, typed in; ends on Applications. */
export async function typeSuperAdminCode(page: Page): Promise<void> {
  const { email, secret } = seededSuperAdmin();
  await page.getByLabel('6-digit code').fill(await computeTwoFactorCode(secret, await nextUnusedTimeStep(email)));
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Applications' })).toBeVisible();
}

/** Signs in as the super admin the development seed creates, types the code from its secret, and waits for Applications. */
export async function signInAsSuperAdmin(page: Page): Promise<void> {
  await signInSuperAdminPassword(page);
  await typeSuperAdminCode(page);
}

/** Opens one application from the queue (the list and the panel side by side on a desktop, one after the other on a phone). */
export async function openApplication(page: Page, stationName: string): Promise<void> {
  await page.goto('/admin/applications');
  await page.getByRole('button', { name: new RegExp(stationName) }).click();
  await expect(page.getByRole('heading', { name: new RegExp(stationName) })).toBeVisible();
  await expect(page.getByText('Opening the licence document…')).toHaveCount(0);
}
