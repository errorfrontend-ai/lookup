import { expect, type Page } from '@playwright/test';

/** Every ad a browser test makes has a title starting with this, so the clean-up can find them all. */
export const BROWSER_TEST_TITLE_PREFIX = 'Browser test ';

/** Signs in as the station owner the development seed creates, and waits for the Overview. Returns the station's id. */
export async function signInAsSeededOwner(page: Page): Promise<string> {
  const email = process.env.SEED_OWNER_EMAIL;
  const password = process.env.SEED_OWNER_PASSWORD;
  if (!email || !password) throw new Error('SEED_OWNER_EMAIL and SEED_OWNER_PASSWORD must be set in apps/api/.env (run npm run database:seed after changing them).');

  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  const stationId = /\/stations\/([0-9a-f-]+)\//.exec(page.url())?.[1];
  if (!stationId) throw new Error(`Signed in, but the address does not name a station: ${new URL(page.url()).pathname}`);
  return stationId;
}

/** Opens the navigation (on a phone it is behind the Menu button) and follows one of its links or buttons. */
export async function useNavigation(page: Page, name: string, isPhone: boolean): Promise<void> {
  if (isPhone) await page.getByRole('button', { name: 'Menu' }).click();
  const navigation = isPhone ? page.getByRole('dialog') : page.locator('aside');
  await navigation.getByRole(name === 'Sign out' ? 'button' : 'link', { name, exact: true }).click();
}
