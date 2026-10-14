import { expect, type Page, test } from '@playwright/test';
import { anotherDevice } from './support/another-device';
import { smsInboxAddress, waitForMessageTo } from './support/mail-inbox';
import { useNavigation } from './support/sign-in';
import { confirmPhoneAndEmail, describeStation, fillInAccount, newStationApplicant, openSignUp, registerApplicant, signUpStation, type StationApplicant } from './support/station-applicant';
import { openApplication, signInAsSuperAdmin } from './support/super-admin';

/**
 * Journey A of the Phase 5a design (§4.1): a station signs up, the super admin approves it, and it signs in to its own
 * pages. It runs at 375 px and at 1280 px (P5A-TESTS-01, -02, -03, -08), against the real stack, with SMS and email
 * read from the development inbox.
 */
test.describe('a station signs up and is approved', () => {
  test('sign-up reaches Under review; the super admin approves; the station is told by SMS and email and signs in to its Overview', async ({ page, browser }, testInfo) => {
    const applicant = newStationApplicant();
    const stationId = await signUpStation(page, browser, applicant);

    // Application status: submitted, and under review now.
    await expect(page.getByRole('listitem').filter({ hasText: 'Under review' })).toHaveAttribute('aria-current', 'step');
    await expect(page.getByText(`${applicant.stationName} · ${applicant.frequencyLabel}`)).toBeVisible();
    const submittedEmail = await waitForMessageTo(applicant.email, /We check every station before it goes live/);
    expect(submittedEmail.subject).toBe(`Look Up received the application for ${applicant.stationName}`);

    // A station still under review is refused the ad routes, in the error envelope (P5A-TESTS-05, S2-AUTHORIZATION-04).
    const adList = await page.request.get(`/api/v1/stations/${stationId}/ads`);
    expect(adList.status()).toBe(403);
    expect((await adList.json()) as unknown).toMatchObject({ error: { code: 'STATION_NOT_ACTIVE', request_id: expect.stringMatching(/^[0-9a-f-]{36}$/) } });
    const newAd = await page.request.post(`/api/v1/stations/${stationId}/ads`, {
      headers: { Origin: 'http://localhost:5180' },
      data: { title: 'Browser test ad that must not exist', clientId: stationId },
    });
    expect(newAd.status()).toBe(403);
    expect(((await newAd.json()) as { error: { code: string } }).error.code).toBe('STATION_NOT_ACTIVE');

    // "Edit application" opens step 3 with the saved answers (P5A-APPLICATION-STATUS-09).
    await page.getByRole('link', { name: 'Edit application' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'About your station' })).toBeVisible();
    await expect(page.getByLabel('Station name')).toHaveValue(applicant.stationName);
    await expect(page.getByLabel('City or town')).toHaveValue(applicant.city);
    // "Sign out" ends the session; signing in again opens Application status, not the dashboard (-01, -04).
    await page.goto(`/stations/${stationId}/application`);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in to your station' })).toBeVisible();
    await page.goto(`/stations/${stationId}/application`);
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in to your station' })).toBeVisible();
    await page.getByLabel('Email').fill(applicant.email);
    await page.getByLabel('Password', { exact: true }).fill(applicant.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Thanks — your application is in' })).toBeVisible();

    // The super admin, on their own device: the checks, the licence document through its short link, then Approve.
    const reviewerDevice = await anotherDevice(browser, testInfo);
    try {
      const reviewer = await reviewerDevice.newPage();
      await signInAsSuperAdmin(reviewer);
      await openApplication(reviewer, applicant.stationName);
      for (const check of ['Phone number verified by SMS', 'Email verified', 'Licence document uploaded']) {
        await expect(reviewer.getByRole('listitem').filter({ hasText: check })).toContainText('Yes');
      }
      await expect(reviewer.getByText(applicant.licenceNumber)).toBeVisible();
      await expect(reviewer.locator('iframe[title="Licence document: licence.pdf"]')).toBeVisible();
      await reviewer.getByRole('button', { name: 'Approve station' }).click();
      await expect(reviewer.getByText('Approved. The station gets an SMS and email.')).toBeVisible();
    } finally {
      await reviewerDevice.close();
    }

    // Told both ways.
    const approvalSms = await waitForMessageTo(smsInboxAddress(applicant.phoneNumberE164), /is approved/);
    expect(approvalSms.text).toBe(`Look Up: ${applicant.stationName} is approved. Sign in to upload your first ad.`);
    const approvalEmail = await waitForMessageTo(applicant.email, /Your station is approved/);
    expect(approvalEmail.subject).toBe(`${applicant.stationName} is approved on Look Up`);

    // The status page says so, and the station's own pages open.
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Your station is approved' })).toBeVisible();
    await page.getByRole('link', { name: 'Go to your station' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    expect((await page.request.get(`/api/v1/stations/${stationId}/ads`)).status()).toBe(200);

    // Signing in afresh lands on the full dashboard too.
    const isPhone = testInfo.project.name === 'phone';
    await useNavigation(page, 'Sign out', isPhone);
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in to your station' })).toBeVisible();
    await page.getByLabel('Email').fill(applicant.email);
    await page.getByLabel('Password', { exact: true }).fill(applicant.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(`/stations/${stationId}/overview`);
    await useNavigation(page, 'Ads', isPhone);
    await expect(page.getByRole('heading', { level: 1, name: 'Ads' })).toBeVisible();
  });

  test('a sign-up resumes where it stopped: after the browser closes, signing in opens the next step, with every answer kept', async ({ browser }, testInfo) => {
    const applicant = newStationApplicant();
    const signIn = async (page: Page, { email, password }: StationApplicant) => {
      await page.goto('/sign-in');
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Sign in' }).click();
    };

    // First visit: steps 1 and 2, then the browser is closed (a dropped connection or a power cut looks the same).
    const firstVisit = await anotherDevice(browser, testInfo);
    const first = await firstVisit.newPage();
    await registerApplicant(first, applicant);
    await confirmPhoneAndEmail(first, browser, applicant);
    await firstVisit.close();

    // Second visit: signing in opens step 3, with steps 1 and 2 behind it. Step 3 is saved, then the browser closes.
    const secondVisit = await anotherDevice(browser, testInfo);
    const second = await secondVisit.newPage();
    await signIn(second, applicant);
    await expect(second.getByRole('heading', { level: 1, name: 'About your station' })).toBeVisible();
    await expect(second.getByText('Step 3 of 4 · Station details')).toBeVisible();
    await describeStation(second, applicant);
    await secondVisit.close();

    // Third visit: step 4 opens, and Back shows step 3's answers as they were saved, and step 2's confirmations.
    const thirdVisit = await anotherDevice(browser, testInfo);
    try {
      const third = await thirdVisit.newPage();
      await signIn(third, applicant);
      await expect(third.getByRole('heading', { level: 1, name: 'Your broadcasting licence' })).toBeVisible();
      await third.getByRole('button', { name: 'Back' }).click();
      await expect(third.getByRole('heading', { level: 1, name: 'About your station' })).toBeVisible();
      await expect(third.getByLabel('Station name')).toHaveValue(applicant.stationName);
      await expect(third.getByLabel('Frequency')).toHaveValue(applicant.frequencyLabel);
      await expect(third.getByLabel('Province')).toHaveValue(applicant.province);
      await expect(third.getByLabel('City or town')).toHaveValue(applicant.city);
      await expect(third.getByRole('img', { name: "Your station's logo" })).toBeVisible();
      await third.getByRole('button', { name: 'Back' }).click();
      await expect(third.getByText('Phone confirmed.')).toBeVisible();
      await expect(third.getByRole('region', { name: 'Confirm your email' }).getByText('Confirmed', { exact: true })).toBeVisible();
    } finally {
      await thirdVisit.close();
    }
  });

  test('on a phone each step is one screen: inputs 48 px with 16 px text, a full-width main button of 52 px, the human check on step 1 only', async ({ page, browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'Sizes are measured on the phone.');
    const applicant = newStationApplicant();
    const problems: string[] = [];
    const measure = async (step: string, mainButton: string) => {
      const sizes = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLInputElement>('main input:not([type="file"]):not([type="checkbox"]), main select')].map((field) => {
          const box = field.getBoundingClientRect();
          return { field: field.id || field.name, height: box.height, fontSize: Number.parseFloat(getComputedStyle(field).fontSize) };
        }),
      );
      for (const { field, height, fontSize } of sizes) {
        if (height < 48) problems.push(`${step}: field ${field} is ${height} px tall`);
        if (fontSize < 16) problems.push(`${step}: field ${field} has ${fontSize} px text`);
      }
      const button = await page.getByRole('button', { name: mainButton, exact: true }).boundingBox();
      if (!button || button.height < 52) problems.push(`${step}: "${mainButton}" is ${button?.height} px tall`);
      if (!button || button.width < 375 - 32) problems.push(`${step}: "${mainButton}" is ${button?.width} px wide`);
      const humanChecks = await page.getByLabel(/Verify you are human/).count();
      if (humanChecks !== (step === 'step 1' ? 1 : 0)) problems.push(`${step}: ${humanChecks} human check(s)`);
    };

    // Step 1, and its "Sign in" link for people who already have an account.
    await openSignUp(page);
    await page.getByRole('link', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in to your station' })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('heading', { level: 1, name: 'Register your station' })).toBeVisible();
    await expect(page.getByLabel(/Verify you are human/)).toBeVisible();
    await measure('step 1', 'Continue');

    await fillInAccount(page, applicant);
    await measure('step 2', 'Continue');
    await confirmPhoneAndEmail(page, browser, applicant);
    await measure('step 3', 'Continue');
    await describeStation(page, applicant);
    await measure('step 4', 'Submit for review');

    // Back from step 4 keeps step 3's answers, and step 2's confirmations; forward again keeps them too.
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByLabel('Station name')).toHaveValue(applicant.stationName);
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByText('Phone confirmed.')).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByLabel('City or town')).toHaveValue(applicant.city);
    expect(problems).toEqual([]);
  });
});
