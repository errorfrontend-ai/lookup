import { randomBytes } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { accessibilityProblems, controlsTooSmallToTap, focusWithoutVisibleOutline, widthsThatScrollSideways } from './support/accessibility';
import { anotherDevice } from './support/another-device';
import { pickFrom, waitForMessageTo } from './support/mail-inbox';
import { signInAsSeededOwner } from './support/sign-in';
import { BROWSER_TEST_EMAIL_DOMAIN } from './support/station-applicant';

const INVITATION_LINK = /(http:\/\/localhost:5180\/invitations\/accept#token=[A-Za-z0-9_-]{43})/;

/** The station invites someone at Brand A from the Clients page's Manage access, and waits for the email. */
async function inviteBrandA(page: Page, stationId: string, email: string, alreadyRead: Set<string>) {
  await page.goto(`/stations/${stationId}/clients`);
  await page.getByRole('button', { name: "Manage who can see Brand A's ads" }).click();
  const dialog = page.getByRole('dialog', { name: "Who can see Brand A's ads" });
  await dialog.getByLabel('Email').fill(email);
  await dialog.getByRole('button', { name: 'Send invitation' }).click();
  await expect(dialog.getByRole('status')).toHaveText('Invitation sent. It works once and lasts 7 days.');
  await expect(dialog.getByText(email, { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  return waitForMessageTo(email, /invitations\/accept#token=/, { alreadyRead });
}

/** Everything the plan asks of a page on every screen (Mobile D): no sideways scrolling, big enough to tap, a visible focus, no axe violation. */
async function pageProblems(page: Page, name: string, tabPresses: number): Promise<string[]> {
  return [
    ...(await widthsThatScrollSideways(page)).map((problem) => `${name}: ${problem}`),
    ...(await controlsTooSmallToTap(page)).map((problem) => `${name}: ${problem}`),
    ...(await focusWithoutVisibleOutline(page, tabPresses)).map((problem) => `${name}: focus not visible on ${problem}`),
    ...(await accessibilityProblems(page)).map((problem) => `${name}: ${problem}`),
  ];
}

/**
 * Client accounts (ADR-006, docs/design/step-5c-client-accounts.md): Station A invites someone at Brand A by email; they
 * make an account from the link and see Brand A's adverts; Station B invites the same person, who accepts signed in and
 * sees the two stations apart; Station A removes the access again, which also leaves the seeded station as it was.
 */
test.describe('client accounts', () => {
  test('a station invites its client; they accept, see their adverts, a second station invites them, and they see both stations apart until access is removed', async ({ page, browser }, testInfo) => {
    const stationA = await signInAsSeededOwner(page);
    const me = (await (await page.request.get('/api/v1/auth/me')).json()) as { stations: Array<{ id: string; name: string }> };
    const stationB = me.stations.find((station) => station.name === 'Station B')?.id as string;
    expect(stationB).toBeDefined();

    const tag = randomBytes(4).toString('hex');
    const invitedEmail = `browser-test-${tag}@${BROWSER_TEST_EMAIL_DOMAIN}`;
    const alreadyRead = new Set<string>();
    const firstInvitation = await inviteBrandA(page, stationA, invitedEmail, alreadyRead);
    // P5C-INVITATIONS-01, P5C-ONBOARDING-04: worded like the team's invitation.
    expect(firstInvitation.subject).toBe("You're invited to view Brand A's adverts on Look Up");
    expect(firstInvitation.text).toContain('The invitation works once and lasts 7 days.');

    const clientDevice = await anotherDevice(browser, testInfo);
    try {
      const client = await clientDevice.newPage();
      const fetched: string[] = [];
      client.on('request', (request) => fetched.push(new URL(request.url()).pathname));

      // P5C-INVITATIONS-02: a new account from the link, then the client's own pages.
      await client.goto(pickFrom(firstInvitation, INVITATION_LINK));
      await expect(client.getByRole('heading', { level: 1, name: "Station A · 98.1 FM invites you to view Brand A's adverts" })).toBeVisible();
      await expect(client.getByText(`Your account will use ${invitedEmail}.`)).toBeVisible();
      await client.getByLabel('Your full name').fill(`Chipo Banda ${tag}`);
      await client.getByLabel('Password', { exact: true }).fill(`${randomBytes(9).toString('base64url')} copper river morning`);
      await client.getByRole('button', { name: 'Create account and accept' }).click();
      await expect(client.getByRole('heading', { level: 1, name: 'Your adverts' })).toBeVisible();
      expect(new URL(client.url()).pathname).toBe('/client');

      // P5C-DASHBOARD-03: the published adverts with their status and schedule, never the draft; the figures and the spreadsheet.
      const sectionA = client.getByRole('region', { name: 'Station A · 98.1 FM' });
      const liveAdvert = sectionA.getByRole('link', { name: /^Summer service offer.*Heard|^Summer service offer.*Not heard/ });
      await expect(liveAdvert).toBeVisible();
      await expect(liveAdvert.getByText('On air', { exact: true })).toBeVisible();
      await expect(sectionA.getByRole('link', { name: /^Spring promo/ }).getByText('Ended', { exact: true })).toBeVisible();
      await expect(sectionA.getByText('New menu launch')).toHaveCount(0);
      await expect(sectionA.getByLabel('Last 7 days on Station A · 98.1 FM')).toBeVisible();
      await expect(sectionA.getByRole('note')).toContainText('View only. To change an ad or its buttons, contact');
      const download = client.waitForEvent('download');
      await sectionA.getByRole('button', { name: 'Download as spreadsheet (CSV) for Station A' }).click();
      expect((await download).suggestedFilename()).toMatch(/^look-up-station-a-\d{4}-\d{2}-\d{2}\.csv$/);
      // P5C-DASHBOARD-10: the spreadsheet button is 48 px tall.
      expect((await sectionA.getByRole('button', { name: /Download as spreadsheet/ }).boundingBox())?.height).toBeGreaterThanOrEqual(47.5);
      // P5C-DASHBOARD-04: no control that changes station data.
      await expect(client.getByRole('button', { name: /edit|delete|pause|publish|upload|archive/i })).toHaveCount(0);
      await expect(client.getByRole('textbox')).toHaveCount(0);
      expect(await pageProblems(client, 'client home', 14)).toEqual([]);

      // P5C-ACCESS-06: opening /client fetches the client's own pages, never the station's ad setup, the console or sign-up.
      fetched.length = 0;
      await client.reload();
      await expect(client.getByRole('heading', { level: 1, name: 'Your adverts' })).toBeVisible();
      await client.waitForLoadState('networkidle');
      expect(fetched).toContain('/src/features/client-area/client-pages.tsx');
      expect(fetched.filter((path) => /\/features\/(new-ad\/ad-setup-page|admin\/|sign-up\/)/.test(path))).toEqual([]);

      // P5C-ADVERT-01 to -04: one advert's page.
      await liveAdvert.click();
      await expect(client.getByRole('heading', { level: 1, name: 'Summer service offer' })).toBeVisible();
      await expect(client.getByRole('region', { name: 'When it airs' })).toContainText('Every day');
      await expect(client.getByRole('heading', { name: 'Next times on air' })).toBeVisible();
      await expect(client.getByRole('region', { name: 'What listeners did' }).getByLabel(/^What listeners did/)).toBeVisible();
      await expect(client.getByRole('region', { name: 'Who is listening' })).toBeVisible();
      await expect(client.getByRole('group', { name: /Preview of what listeners see/ })).toContainText('Call Brand A');
      await expect(client.getByRole('note')).toContainText('View only. To change this ad or its buttons, contact');
      await expect(client.getByRole('textbox')).toHaveCount(0);
      expect(await pageProblems(client, 'advert page', 12)).toEqual([]);
      const advertPath = new URL(client.url()).pathname;

      // P5C-DASHBOARD-05: the menu's Account page.
      if (testInfo.project.name === 'phone') await client.getByRole('button', { name: 'Menu' }).click();
      await client.getByRole('navigation', { name: testInfo.project.name === 'phone' ? 'Menu' : 'Client menu' }).getByRole('link', { name: 'Account' }).click();
      await expect(client.getByRole('heading', { level: 1, name: 'Your account' })).toBeVisible();
      expect(await pageProblems(client, 'account page', 8)).toEqual([]);

      // P5C-ONBOARDING-03, P5C-TESTS-01: Station B invites the same person, who accepts signed in; two stations, apart.
      const secondInvitation = await inviteBrandA(page, stationB, invitedEmail, alreadyRead);
      await client.goto(pickFrom(secondInvitation, INVITATION_LINK));
      await expect(client.getByRole('heading', { level: 1, name: "Station B · 104.3 FM invites you to view Brand A's adverts" })).toBeVisible();
      await client.getByRole('button', { name: 'Accept', exact: true }).click();
      await expect(client.getByRole('heading', { level: 1, name: 'Your adverts' })).toBeVisible();
      await expect(client.getByRole('region', { name: 'Station A · 98.1 FM' })).toBeVisible();
      const sectionB = client.getByRole('region', { name: 'Station B · 104.3 FM' });
      await expect(sectionB).toBeVisible();
      await expect(sectionB.getByLabel('Last 7 days on Station B · 104.3 FM')).toBeVisible();
      await expect(sectionB.getByText('Spring promo')).toHaveCount(0);

      // P5C-ONBOARDING-06: Station A removes the access; on the next request Station A is gone and its advert is not found.
      await page.goto(`/stations/${stationA}/clients`);
      await page.getByRole('button', { name: "Manage who can see Brand A's ads" }).click();
      const dialog = page.getByRole('dialog', { name: "Who can see Brand A's ads" });
      await dialog.getByRole('button', { name: new RegExp(`^Remove access\\W+Chipo Banda ${tag}$`) }).click();
      await dialog.getByRole('group', { name: `Remove Chipo Banda ${tag}'s access?` }).getByRole('button', { name: 'Remove access' }).click();
      await expect(dialog.getByText(invitedEmail)).toHaveCount(0);
      await client.reload();
      await expect(client.getByRole('region', { name: 'Station B · 104.3 FM' })).toBeVisible();
      await expect(client.getByRole('region', { name: 'Station A · 98.1 FM' })).toHaveCount(0);
      await client.goto(advertPath);
      await expect(client.getByRole('heading', { level: 1, name: "We couldn't find that advert" })).toBeVisible();
    } finally {
      await clientDevice.close();
    }
  });
});
