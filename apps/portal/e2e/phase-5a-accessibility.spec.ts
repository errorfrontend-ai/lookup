import { expect, type Page, test } from '@playwright/test';
import { anotherDevice } from './support/another-device';
import { accessibilityProblems, areSideBySide, controlsTooSmallToTap, focusWithoutVisibleOutline, widthsThatScrollSideways } from './support/accessibility';
import { signInAsSeededOwner } from './support/sign-in';
import { confirmPhoneAndEmail, describeStation, fillInAccount, newStationApplicant, openSignUp, submitLicence } from './support/station-applicant';
import { openApplication, signInSuperAdminPassword, typeSuperAdminCode } from './support/super-admin';

/**
 * Every Phase 5a screen in a real browser (P5A-TESTS-11, P5A-RESPONSIVE): axe with colour contrast finds nothing;
 * every control is at least 44 px tall, on a phone and on a desktop; on a desktop every control the keyboard reaches
 * shows its focus, and no page scrolls sideways at 320, 375, 768, 1024 or 1280 px. A fresh applicant is walked through sign-up so each step
 * is checked as a person sees it, then a reviewer's console, then the Team page.
 */
test.describe('accessibility of the Phase 5a screens', () => {
  test('sign-up, application status, the admin console and the Team page pass axe, focus, tap-size and width checks', async ({ page, browser }, testInfo) => {
    test.setTimeout(300_000);
    const isPhone = testInfo.project.name === 'phone';
    const problems: string[] = [];
    const check = async (onPage: Page, screen: string, tabPresses = 12, columns?: [string, string]) => {
      // Not "network idle": step 2 keeps asking whether the email is confirmed. Whatever is loading says so instead.
      await expect(onPage.getByText(/Loading|Opening the/)).toHaveCount(0);
      problems.push(...(await accessibilityProblems(onPage)).map((problem) => `${screen}: ${problem}`));
      // 44 px at both widths: the console is used on desktops as well as phones (P5A-ADMIN-ACCESS-07).
      problems.push(...(await controlsTooSmallToTap(onPage)).map((problem) => `${screen}: ${problem}`));
      if (!isPhone) {
        problems.push(...(await focusWithoutVisibleOutline(onPage, tabPresses)).map((control) => `${screen}: ${control} takes focus without a visible outline`));
        problems.push(...(await widthsThatScrollSideways(onPage)).map((width) => `${screen}: scrolls sideways at ${width}`));
        // P5A-RESPONSIVE-02: one column on a phone, two at 1280 px.
        if (columns && !(await areSideBySide(onPage, ...columns, 1280))) problems.push(`${screen}: "${columns[0]}" and "${columns[1]}" are not side by side at 1280 px`);
        if (columns && (await areSideBySide(onPage, ...columns, 375))) problems.push(`${screen}: "${columns[0]}" and "${columns[1]}" are side by side at 375 px`);
      }
    };

    // The applicant, step by step.
    const applicant = newStationApplicant();
    await openSignUp(page);
    await expect(page.getByLabel(/Verify you are human/)).toBeVisible();
    await check(page, 'sign-up step 1, Register your station', 12, ['Your full name', 'Work email']);
    const stationId = await fillInAccount(page, applicant);
    await check(page, 'sign-up step 2, Check your phone');
    await confirmPhoneAndEmail(page, browser, applicant);
    await check(page, 'sign-up step 3, About your station', 16, ['Station name', 'Frequency']);
    await describeStation(page, applicant);
    await check(page, 'sign-up step 4, Your broadcasting licence', 12, ['Licence number', 'Licence document']);
    await submitLicence(page, applicant);
    await check(page, 'Application status, under review');
    await page.goto(`/stations/${stationId}/application/account`);
    await expect(page.getByRole('heading', { level: 1, name: 'Your account' })).toBeVisible();
    await check(page, 'sign-up, changing the account', 12, ['Your full name', 'Work email']);

    // The pages a link opens, here without a usable token.
    await page.goto('/verify-email');
    await expect(page.getByRole('heading', { level: 1, name: "This link doesn't work" })).toBeVisible();
    await check(page, 'email link, no token');
    await page.goto('/invitations/accept');
    await expect(page.getByRole('heading', { level: 1, name: "This invitation link doesn't work" })).toBeVisible();
    await check(page, 'invitation link, no token');

    // The reviewer's console.
    const reviewerDevice = await anotherDevice(browser, testInfo);
    try {
      const reviewer = await reviewerDevice.newPage();
      await signInSuperAdminPassword(reviewer);
      await check(reviewer, 'the super admin’s code');
      await typeSuperAdminCode(reviewer);
      await check(reviewer, 'Applications', 20);
      await openApplication(reviewer, applicant.stationName);
      await expect(reviewer.locator('iframe[title="Licence document: licence.pdf"]')).toBeVisible();
      await check(reviewer, 'an application under review', 30);

      await reviewer.getByLabel(/Reason \(needed to reject/).fill('The licence number does not match the document. Please check it and submit again.');
      await reviewer.getByRole('button', { name: 'Reject', exact: true }).click();
      await expect(reviewer.getByText('Rejected. The station gets an SMS and email with your reason.')).toBeVisible();
      await page.goto(`/stations/${stationId}/application`);
      await expect(page.getByRole('listitem').filter({ hasText: 'Rejected' })).toHaveAttribute('aria-current', 'step');
      await check(page, 'Application status, rejected');

      for (const [path, heading] of [
        ['/admin/stations', 'Stations'],
        ['/admin/audio-to-check', 'Audio to check'],
        ['/admin/system-health', 'System health'],
        ['/admin/reference-codes', 'Find by reference code'],
      ] as const) {
        await reviewer.goto(path);
        await expect(reviewer.getByRole('heading', { level: 1, name: heading })).toBeVisible();
        await check(reviewer, heading, 20);
      }
    } finally {
      await reviewerDevice.close();
    }

    // The Team page, as the seeded station's owner.
    const ownerDevice = await anotherDevice(browser, testInfo);
    try {
      const owner = await ownerDevice.newPage();
      const seededStationId = await signInAsSeededOwner(owner);
      await owner.goto(`/stations/${seededStationId}/team`);
      await expect(owner.getByRole('heading', { level: 1, name: 'Team' })).toBeVisible();
      await check(owner, 'Team', 20, ['Email', 'Role']);
    } finally {
      await ownerDevice.close();
    }

    expect(problems).toEqual([]);
  });
});
