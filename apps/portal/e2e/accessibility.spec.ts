import { expect, test } from '@playwright/test';
import { controlsTooSmallToTap, focusWithoutVisibleOutline } from './support/accessibility';
import { signInAsSeededOwner } from './support/sign-in';

test.describe('accessibility in the browser', () => {
  test('every control a keyboard reaches shows where the focus is', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'phone', 'A keyboard is checked on the desktop.');
    const stationId = await signInAsSeededOwner(page);

    await page.goto(`/stations/${stationId}/ads`);
    await expect(page.getByRole('heading', { level: 1, name: 'Ads' })).toBeVisible();
    expect(await focusWithoutVisibleOutline(page, 30)).toEqual([]);

    await page.goto(`/stations/${stationId}/ads/new`);
    await page.getByRole('radio', { name: /Brand A/ }).check();
    expect(await focusWithoutVisibleOutline(page, 12)).toEqual([]);
  });

  test('every control on the station screens is big enough to tap on a phone', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'Touch targets are checked on the phone.');
    const stationId = await signInAsSeededOwner(page);

    const screens: Array<[name: string, path: string, heading: string]> = [
      ['overview', `/stations/${stationId}/overview`, 'Overview'],
      ['ads', `/stations/${stationId}/ads`, 'Ads'],
      ['clients', `/stations/${stationId}/clients`, 'Clients'],
      ['station profile', `/stations/${stationId}/profile`, 'Station profile'],
      ['new ad', `/stations/${stationId}/ads/new`, 'Who is this ad for?'],
    ];
    const problems: string[] = [];
    for (const [name, path, heading] of screens) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      await page.waitForLoadState('networkidle');
      problems.push(...(await controlsTooSmallToTap(page)).map((problem) => `${name}: ${problem}`));
    }

    // An ad's own page, with each of its tabs.
    await page.goto(`/stations/${stationId}/ads`);
    await page.getByRole('article').first().getByRole('link').first().click();
    await expect(page.getByRole('tab', { selected: true }).or(page.getByRole('link', { name: 'Overview', exact: true }))).toBeVisible();
    for (const tab of ['Overview', 'Buttons', 'Schedule', 'History']) {
      await page.getByRole('link', { name: tab, exact: true }).click();
      await page.waitForLoadState('networkidle');
      problems.push(...(await controlsTooSmallToTap(page)).map((problem) => `ad page, ${tab}: ${problem}`));
    }
    expect(problems).toEqual([]);
  });
});
