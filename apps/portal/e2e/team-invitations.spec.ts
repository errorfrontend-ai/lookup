import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { anotherDevice } from './support/another-device';
import { pickFrom, waitForMessageTo } from './support/mail-inbox';
import { signInAsSeededOwner } from './support/sign-in';
import { BROWSER_TEST_EMAIL_DOMAIN } from './support/station-applicant';

/**
 * Journey E of the Phase 5a design (§4.1): the owner invites someone by email, they join with a new account and see
 * what their role allows, and the owner removes them again, which also leaves the seeded station as it was.
 */
test.describe('the station team', () => {
  test('the owner invites an analyst; they join from the email with a new account, see the team without its controls, and are removed again', async ({ page, browser }, testInfo) => {
    const stationId = await signInAsSeededOwner(page);
    await page.goto(`/stations/${stationId}/team`);
    await expect(page.getByRole('heading', { level: 1, name: 'Team' })).toBeVisible();

    const tag = randomBytes(4).toString('hex');
    const invitedEmail = `browser-test-${tag}@${BROWSER_TEST_EMAIL_DOMAIN}`;
    // A name of its own, so a member left by a run that stopped half way can never be mistaken for this one.
    const inviteeName = `Mutale Banda ${tag}`;
    const invite = page.getByRole('region', { name: 'Invite someone' });
    await invite.getByLabel('Email').fill(invitedEmail);
    await invite.getByRole('radio', { name: /Analyst/ }).check();
    await invite.getByRole('button', { name: 'Send invitation' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Invitation sent. It works once and lasts 7 days.' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Pending invitations' }).getByText(invitedEmail, { exact: true })).toBeVisible();

    const invitation = await waitForMessageTo(invitedEmail, /invitations\/accept#token=/);
    expect(invitation.subject).toMatch(/^You're invited to .+ on Look Up$/);
    expect(invitation.text).toContain('as an analyst');

    const inviteeDevice = await anotherDevice(browser, testInfo);
    try {
      const invitee = await inviteeDevice.newPage();
      await invitee.goto(pickFrom(invitation, /(http:\/\/localhost:5180\/invitations\/accept#token=[A-Za-z0-9_-]{43})/));
      await expect(invitee.getByRole('heading', { level: 1, name: /^You're invited to join .+ as an Analyst$/ })).toBeVisible();
      await expect(invitee.getByText(`Your account will use ${invitedEmail}.`)).toBeVisible();
      await invitee.getByLabel('Your full name').fill(inviteeName);
      await invitee.getByLabel('Password', { exact: true }).fill(`${randomBytes(9).toString('base64url')} copper river morning`);
      await invitee.getByRole('button', { name: 'Join', exact: true }).click();
      await expect(invitee.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
      expect(new URL(invitee.url()).pathname).toBe(`/stations/${stationId}/overview`);

      // An analyst sees the team but cannot change it.
      await invitee.goto(`/stations/${stationId}/team`);
      await expect(invitee.getByRole('heading', { level: 1, name: 'Team' })).toBeVisible();
      await expect(invitee.getByRole('region', { name: 'Members' }).getByText(new RegExp(`^${inviteeName}`))).toBeVisible();
      await expect(invitee.getByRole('region', { name: 'Invite someone' })).toHaveCount(0);
      await expect(invitee.getByRole('button', { name: /Remove from team/ })).toHaveCount(0);

      // The owner sees the new member, the invitation used up, and removes them.
      await page.reload();
      await expect(page.getByRole('region', { name: 'Pending invitations' }).getByText(invitedEmail, { exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: new RegExp(`^Remove from team\\W+${inviteeName}$`) }).click();
      const confirm = page.getByRole('dialog', { name: `Remove ${inviteeName} from the team?` });
      await confirm.getByRole('button', { name: 'Remove from team' }).click();
      await expect(page.getByRole('region', { name: 'Members' }).getByText(new RegExp(`^${inviteeName}`))).toHaveCount(0);

      // Removed means removed: the station's pages are closed to them at once.
      const afterRemoval = await invitee.request.get(`/api/v1/stations/${stationId}/ads`);
      expect([403, 404]).toContain(afterRemoval.status());
    } finally {
      await inviteeDevice.close();
    }
  });
});
