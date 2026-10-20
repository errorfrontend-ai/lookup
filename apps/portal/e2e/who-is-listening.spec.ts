import { expect, test } from '@playwright/test';
import { signInAsSeededOwner } from './support/sign-in';

/**
 * Who is listening on the real stack (ADR-005; LA-STATS-07): the migration's functions, the two routes and the portal's
 * section, once as a phone and once on a desktop. The seeded station has no listener accounts, so the section shows its
 * counts and says why there are no groups yet; the groups themselves are proved by the API's and the portal's own tests.
 */
test.describe('who is listening', () => {
  test('Overview shows who is listening for the page’s dates, and an ad’s Overview tab has its own date choice', async ({ page }, testInfo) => {
    /** The answer to the next request for who is listening at [range], for the station or (with [onAnAd]) one of its ads. */
    const answerFor = (range: string, onAnAd: boolean) =>
      page.waitForResponse((response) => {
        const address = new URL(response.url());
        return /\/listener-mix$/.test(address.pathname) && /\/ads\//.test(address.pathname) === onAnAd && address.searchParams.get('range') === range;
      });
    const firstAnswer = answerFor('last7Days', false);
    const stationId = await signInAsSeededOwner(page);
    expect((await firstAnswer).status()).toBe(200);

    const overview = page.getByRole('region', { name: 'Who is listening' });
    await expect(overview.getByRole('heading', { name: 'Who is listening' })).toBeVisible();
    await expect(overview.getByLabel('Listeners')).toBeVisible();
    await expect(overview.getByText(/^Last 7 days ·/)).toBeVisible();
    await expect(overview.getByRole('alert')).toHaveCount(0);
    const monthAnswer = answerFor('last30Days', false);
    await page.getByLabel('Date range').selectOption('last30Days');
    expect((await monthAnswer).status()).toBe(200);
    await expect(overview.getByText(/^Last 30 days ·/)).toBeVisible();

    await page.goto(`/stations/${stationId}/ads`);
    await expect(page.getByRole('heading', { level: 1, name: 'Ads' })).toBeVisible();
    // The first ad of the list: a table on the desktop, cards on a phone.
    const firstAd = testInfo.project.name === 'phone' ? page.getByRole('article').first().getByRole('link').first() : page.getByRole('table').getByRole('link').first();
    const adWeekAnswer = answerFor('last7Days', true);
    await firstAd.click();
    expect((await adWeekAnswer).status()).toBe(200);
    const onTheAd = page.getByRole('region', { name: 'Who is listening' });
    await expect(onTheAd.getByText('Different people who identified this ad')).toBeVisible();
    const adTodayAnswer = answerFor('today', true);
    await onTheAd.getByLabel('Dates for who is listening').selectOption('today');
    expect((await adTodayAnswer).status()).toBe(200);
    await expect(onTheAd.getByText(/^Today ·/)).toBeVisible();
    await expect(onTheAd.getByRole('alert')).toHaveCount(0);
  });
});
