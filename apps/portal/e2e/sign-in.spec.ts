import { expect, test } from '@playwright/test';
import { signInAsSeededOwner, useNavigation } from './support/sign-in';

test.describe('signing in and out', () => {
  test('a wrong email or password is refused in plain words, with a reference to quote', async ({ page }) => {
    // An address that does not exist, so the seeded owner's failed-attempt count is never touched.
    await page.goto('/sign-in');
    await page.getByLabel('Email').fill('nobody@example.invalid');
    await page.getByLabel('Password', { exact: true }).fill('not the right password at all');
    await page.getByRole('button', { name: 'Sign in' }).click();

    const notice = page.getByRole('alert');
    await expect(notice).toContainText('The email or password is not correct.');
    await expect(notice).toContainText(/Reference: [0-9a-f-]{8,}/);
    await expect(notice).not.toContainText(/Error|Exception|SQL|at \w+ \(/);
    await expect(page).toHaveURL(/\/sign-in/);
  });

  test('the station owner signs in to the Overview, and signing out returns to Sign in', async ({ page }, testInfo) => {
    await signInAsSeededOwner(page);
    await expect(page.getByRole('region', { name: 'Your ads at a glance' })).toBeVisible();

    await useNavigation(page, 'Sign out', testInfo.project.name === 'phone');
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in to your station' })).toBeVisible();

    // Signed out means signed out: a station page sends the person back to Sign in.
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in to your station' })).toBeVisible();
  });
});
