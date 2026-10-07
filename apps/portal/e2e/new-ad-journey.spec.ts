import { expect, test } from '@playwright/test';
import { createSampleJingleWav } from '../../api/scripts/sample-audio';
import { BROWSER_TEST_TITLE_PREFIX, signInAsSeededOwner, useNavigation } from './support/sign-in';

/**
 * The whole job a station does in the portal, in a real browser against the real API, storage and
 * database: choose the client, upload real audio, add buttons, set when it airs, review and publish,
 * then find the ad in the list with its history. On a phone the times are chosen as a list; on a
 * desktop with the hour grid.
 */
test('a station puts an ad on air: client, audio, buttons, schedule, review, publish', async ({ page }, testInfo) => {
  const isPhone = testInfo.project.name === 'phone';
  const title = `${BROWSER_TEST_TITLE_PREFIX}${testInfo.project.name} ${Date.now()}`;
  const stationId = await signInAsSeededOwner(page);

  await test.step('who it is for', async () => {
    await page.getByRole('link', { name: 'Upload ad' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Who is this ad for?' })).toBeVisible();
    await expect(page.getByText('Nothing saved yet')).toBeVisible();
    await page.getByRole('radio', { name: /Brand A/ }).check();
    await page.getByRole('button', { name: 'Next: Audio' }).click();
  });

  await test.step('the audio goes up and is checked', async () => {
    await expect(page.getByRole('heading', { level: 1, name: 'Upload the ad' })).toBeVisible();
    await page.getByLabel('Audio file').setInputFiles({ name: 'browser-test-jingle.wav', mimeType: 'audio/wav', buffer: createSampleJingleWav() });
    await page.getByLabel('Ad title').fill(title);
    await page.getByRole('button', { name: 'Upload ad' }).click();

    await expect(page).toHaveURL(/\/ads\/[0-9a-f-]+\/setup\?step=audio$/);
    const progress = page.getByRole('list', { name: 'Upload progress' });
    await expect(progress.getByText('Uploaded')).toBeVisible();
    await expect(progress.getByText('Checked')).toBeVisible();
    await expect(page.getByText('Draft saved')).toBeVisible();
    await page.getByRole('button', { name: 'Next: Buttons' }).click();
  });

  await test.step('a Call button and a Website button, with what they were understood as', async () => {
    await expect(page.getByRole('heading', { level: 1, name: 'Add the buttons' })).toBeVisible();
    await page.getByRole('button', { name: 'Add a Call button' }).click();
    const call = page.getByRole('listitem', { name: 'Button 1' });
    await call.getByLabel('Phone number').fill('0977 123 456');
    await expect(call.getByText('Calls +260 97 712 3456')).toBeVisible();

    await page.getByRole('button', { name: 'Add a Website button' }).click();
    const website = page.getByRole('listitem', { name: 'Button 2' });
    await website.getByLabel('Web address').fill('http://brand.co.zm/book');
    await website.getByLabel('Web address').blur();
    await expect(website.getByText(/Addresses must start with https:\/\//)).toBeVisible();
    await website.getByLabel('Web address').fill('brand.co.zm/book');
    await expect(website.getByText('Opens https://brand.co.zm/book')).toBeVisible();

    if (isPhone) await page.getByRole('button', { name: 'Preview', exact: true }).click();
    const preview = page.getByRole('group', { name: /Preview of what listeners see/ });
    await expect(preview.getByText('Call us')).toBeVisible();
    await expect(preview.getByText('Visit our website')).toBeVisible();
    await page.getByRole('button', { name: 'Save and continue' }).click();
  });

  await test.step('when it airs', async () => {
    await expect(page.getByRole('heading', { level: 1, name: 'Set when it airs' })).toBeVisible();
    if (isPhone) {
      await page.getByRole('button', { name: 'Add a time' }).click();
      await expect(page.getByRole('listitem', { name: 'Time slot 1' }).getByText('Mon–Fri · 07:00–09:00')).toBeVisible();
    } else {
      await page.getByRole('button', { name: 'Switch 07:00 to 08:00 on or off for every day' }).click();
      await page.getByRole('button', { name: 'Switch 08:00 to 09:00 on or off for every day' }).click();
    }
    const week = page.getByRole('region', { name: 'The week' });
    await expect(week.getByText(isPhone ? 'Mon–Fri · 07:00–09:00' : 'Every day · 07:00–09:00')).toBeVisible();
    await page.getByRole('button', { name: 'Save and continue' }).click();
  });

  await test.step('review and publish', async () => {
    await expect(page.getByRole('heading', { level: 1, name: 'Review and publish' })).toBeVisible();
    await expect(page.getByText('Ready to publish')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Buttons' }).getByText('+260 97 712 3456')).toBeVisible();
    await page.getByRole('button', { name: 'Publish', exact: true }).click();

    const question = page.getByRole('dialog', { name: `Publish “${title}”?` });
    await expect(question).toContainText('It goes on air by the schedule you set');
    await question.getByRole('button', { name: 'Publish', exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`/stations/${stationId}/ads/[0-9a-f-]+$`));
    await expect(page.getByText(/^Published\. It (is on air now|goes on air)/)).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  });

  await test.step('the ad is in the list, published, and its history says so', async () => {
    const recent = page.getByRole('region', { name: 'Recent changes' });
    await expect(recent.getByText('published the ad')).toBeVisible();

    await useNavigation(page, 'Ads', isPhone);
    await page.getByPlaceholder('Search title or client').fill(title);
    const adLink = page.getByRole('link', { name: title, exact: true });
    await expect(adLink).toBeVisible();
    // The ad's own row (a table on a desktop, a card on a phone) shows it published, not a draft.
    const adRow = page.locator('tr, article').filter({ has: adLink });
    await expect(adRow.getByText(/^(Scheduled|On air now)$/)).toBeVisible();
    await expect(adRow.getByText('Draft', { exact: true })).toHaveCount(0);
  });
});
