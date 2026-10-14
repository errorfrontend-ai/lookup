import { expect, test } from '@playwright/test';
import { anotherDevice } from './support/another-device';
import { smsInboxAddress, waitForMessageTo } from './support/mail-inbox';
import { describeStation, newStationApplicant, signUpStation, submitLicence } from './support/station-applicant';
import { signInAsSeededOwner } from './support/sign-in';
import { openApplication, signInAsSuperAdmin } from './support/super-admin';

const REASON = 'The licence photo is too blurry to read the number. Please upload a clearer copy.';

/**
 * Journey D of the Phase 5a design (§4.1): the super admin rejects an application with a reason, the station reads it
 * word for word, fixes it and submits again, and the application returns to the queue, where it is approved
 * (P5A-TESTS-04, -09).
 */
test.describe('the super admin reviews an application', () => {
  test('a rejection shows the reason; the station fixes it and submits again; back in the queue, it is approved', async ({ page, browser }, testInfo) => {
    const applicant = newStationApplicant();
    const stationId = await signUpStation(page, browser, applicant);

    const reviewerDevice = await anotherDevice(browser, testInfo);
    try {
      const reviewer = await reviewerDevice.newPage();
      await signInAsSuperAdmin(reviewer);
      await openApplication(reviewer, applicant.stationName);

      // Reject needs a reason, which the station will see.
      const reject = reviewer.getByRole('button', { name: 'Reject', exact: true });
      await expect(reject).toBeDisabled();
      await reviewer.getByLabel(/Reason \(needed to reject/).fill(REASON);
      await reject.click();
      await expect(reviewer.getByText('Rejected. The station gets an SMS and email with your reason.')).toBeVisible();
      await reviewer.getByRole('button', { name: 'Back to the applications' }).click();
      await expect(reviewer.getByRole('heading', { level: 1, name: 'Applications' })).toBeVisible();
      await expect(reviewer.getByRole('button', { name: new RegExp(applicant.stationName) })).toHaveCount(0);

      // The station is told, with the reviewer's words in the email.
      const rejectionSms = await waitForMessageTo(smsInboxAddress(applicant.phoneNumberE164), /needs changes/);
      expect(rejectionSms.text).toContain(applicant.stationName);
      const rejectionEmail = await waitForMessageTo(applicant.email, /The reviewer wrote/);
      expect(rejectionEmail.subject).toBe(`Your Look Up application for ${applicant.stationName} needs changes`);
      expect(rejectionEmail.text).toContain(REASON);

      // The applicant reads the reason, fixes the licence and submits again.
      await page.reload();
      const rejected = page.getByRole('listitem').filter({ hasText: 'Rejected' });
      await expect(rejected).toHaveAttribute('aria-current', 'step');
      await expect(rejected).toContainText(REASON);
      await page.getByRole('link', { name: 'Fix and submit again' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'About your station' })).toBeVisible();
      await expect(page.getByLabel('Station name')).toHaveValue(applicant.stationName);
      await describeStation(page, applicant);
      await submitLicence(page, applicant, 'Submit again');
      await expect(page.getByRole('listitem').filter({ hasText: 'Under review' })).toHaveAttribute('aria-current', 'step');

      // Back in the queue, and approved this time.
      await openApplication(reviewer, applicant.stationName);
      await reviewer.getByRole('button', { name: 'Approve station' }).click();
      await expect(reviewer.getByText('Approved. The station gets an SMS and email.')).toBeVisible();
    } finally {
      await reviewerDevice.close();
    }

    await waitForMessageTo(smsInboxAddress(applicant.phoneNumberE164), /is approved/);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Your station is approved' })).toBeVisible();
    await page.getByRole('link', { name: 'Go to your station' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(`/stations/${stationId}/overview`);
  });

  test('the console has a sidebar on a desktop and a Menu drawer on a phone; a station user who opens it is sent to their own station', async ({ page, browser }, testInfo) => {
    const isPhone = testInfo.project.name === 'phone';
    await signInAsSuperAdmin(page);
    const places = ['Applications', 'Stations', 'Audio to check', 'System health', 'Find by reference code'];
    const menuButton = page.getByRole('button', { name: 'Menu' });
    if (isPhone) {
      await expect(page.locator('aside')).toBeHidden();
      await menuButton.click();
      const drawer = page.getByRole('dialog', { name: 'Menu' });
      for (const place of places) await expect(drawer.getByRole('link', { name: new RegExp(`^${place}`) })).toBeVisible();
      await drawer.getByRole('link', { name: /^Stations/ }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Stations' })).toBeVisible();
      await expect(drawer).toBeHidden();
    } else {
      await expect(menuButton).toBeHidden();
      const sidebar = page.locator('aside');
      for (const place of places) await expect(sidebar.getByRole('link', { name: new RegExp(`^${place}`) })).toBeVisible();
    }

    const ownerDevice = await anotherDevice(browser, testInfo);
    try {
      const owner = await ownerDevice.newPage();
      const stationId = await signInAsSeededOwner(owner);
      await owner.goto('/admin/applications');
      await expect(owner.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
      expect(new URL(owner.url()).pathname).toBe(`/stations/${stationId}/overview`);
      await expect(owner.getByText('Super admin')).toHaveCount(0);
    } finally {
      await ownerDevice.close();
    }
  });
});
