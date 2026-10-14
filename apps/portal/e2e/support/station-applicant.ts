import { randomBytes, randomInt } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { type Browser, expect, type Page } from '@playwright/test';
import { pickFrom, smsInboxAddress, waitForMessageTo } from './mail-inbox';

/** Every station a browser test signs up is named with this, so a person can tell them apart in the console. */
export const BROWSER_TEST_STATION_PREFIX = 'Browser test station ';
/** Every account a browser test makes uses this domain, which can never receive mail (RFC 2606). */
export const BROWSER_TEST_EMAIL_DOMAIN = 'example.test';

/** Cloudflare's dummy token, which the API's offline test-key verifier accepts (P5A-D8). */
const HUMAN_CHECK_DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

/**
 * A stand-in for Turnstile's script (P5A design §11): a tick box that hands the dummy token to the widget's
 * callback. Every other request to Cloudflare is refused, so the tests never depend on the internet.
 */
const HUMAN_CHECK_STAND_IN = `
window.turnstile = {
  render(element, options) {
    const label = document.createElement('label');
    label.style.cssText = 'display:inline-flex;align-items:center;gap:12px;min-height:48px;padding:0 12px;border:1px solid currentColor;border-radius:6px';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.style.cssText = 'width:20px;height:20px';
    box.addEventListener('change', () => (box.checked ? options.callback(${JSON.stringify(HUMAN_CHECK_DUMMY_TOKEN)}) : options['expired-callback']()));
    label.append(box, 'Verify you are human (browser-test stand-in)');
    element.append(label);
    return 'browser-test-widget';
  },
  remove() {},
};`;

export async function useStandInHumanCheck(page: Page): Promise<void> {
  await page.route('https://challenges.cloudflare.com/**', (route) =>
    route.request().url().startsWith('https://challenges.cloudflare.com/turnstile/v0/api.js')
      ? route.fulfill({ contentType: 'text/javascript', body: HUMAN_CHECK_STAND_IN })
      : route.abort(),
  );
}

/**
 * Gives this page's API calls an address of their own (from 198.18.0.0/15, kept for tests by RFC 2544), so the
 * per-address sign-up limits (5 applicants an hour) count each journey apart. The portal's development proxy
 * passes the header on and the API trusts one proxy, as it does behind Render's.
 */
export async function useOwnClientAddress(page: Page): Promise<void> {
  const address = `198.${18 + randomInt(2)}.${randomInt(256)}.${1 + randomInt(254)}`;
  await page.route('**/api/v1/**', (route) => route.continue({ headers: { ...route.request().headers(), 'x-forwarded-for': address } }));
}

export interface StationApplicant {
  fullName: string;
  email: string;
  /** As typed after the fixed +260. */
  mobileNumber: string;
  phoneNumberE164: string;
  password: string;
  stationName: string;
  frequencyLabel: string;
  province: string;
  city: string;
  licenceNumber: string;
}

/** A new applicant: a random Zambian-format number that nothing is ever sent to, and an address that cannot receive mail. */
export function newStationApplicant(): StationApplicant {
  const tag = randomBytes(4).toString('hex');
  const subscriber = String(randomInt(1_000_000, 10_000_000));
  return {
    fullName: 'Chanda Mwila',
    email: `browser-test-${tag}@${BROWSER_TEST_EMAIL_DOMAIN}`,
    mobileNumber: `97 ${subscriber.slice(0, 3)} ${subscriber.slice(3)}`,
    phoneNumberE164: `+26097${subscriber}`,
    // Random words: never in a breach list and sharing nothing with the name or the email.
    password: `${randomBytes(9).toString('base64url')} quiet harbour lantern`,
    stationName: `${BROWSER_TEST_STATION_PREFIX}${tag}`,
    frequencyLabel: `${87 + randomInt(21)}.${randomInt(10)} FM`,
    province: 'Lusaka',
    city: 'Chongwe',
    licenceNumber: `IBA/BT/${tag.toUpperCase()}`,
  };
}

/** A small PDF: the API checks a licence document's first bytes, and a reviewer's browser shows it. */
export function licenceDocumentPdf(): Buffer {
  return Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
    'latin1',
  );
}

/** A plain square PNG, made here so no image file is kept in the repository. */
export function squareLogoPng(sidePixels = 96): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(typeAndData));
    return Buffer.concat([length, typeAndData, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(sidePixels, 0);
  header.writeUInt32BE(sidePixels, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bits, RGB, no interlace
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(sidePixels * 3, Buffer.from([0x1f, 0x6f, 0xd1]))]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: sidePixels }, () => row)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))]);
}

/** The station's id from an address under /stations/:id/. */
export function stationIdIn(page: Page): string {
  const stationId = /\/stations\/([0-9a-f-]{36})\//.exec(page.url())?.[1];
  if (!stationId) throw new Error(`The address does not name a station: ${new URL(page.url()).pathname}`);
  return stationId;
}

/** Opens step 1, with the stand-in human check and an address of this journey's own. */
export async function openSignUp(page: Page): Promise<void> {
  await useStandInHumanCheck(page);
  await useOwnClientAddress(page);
  await page.goto('/signup');
  await expect(page.getByRole('heading', { level: 1, name: 'Register your station' })).toBeVisible();
}

/** Step 1, already open: the account. Ends on step 2 and returns the new station's id. */
export async function fillInAccount(page: Page, applicant: StationApplicant): Promise<string> {
  await page.getByLabel('Your full name').fill(applicant.fullName);
  await page.getByLabel('Work email').fill(applicant.email);
  await page.getByLabel('Mobile number').fill(applicant.mobileNumber);
  await page.getByLabel('Password', { exact: true }).fill(applicant.password);
  await page.getByLabel(/Verify you are human/).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Check your phone' })).toBeVisible();
  return stationIdIn(page);
}

/** Step 1 from the start. Ends on step 2 and returns the new station's id. */
export async function registerApplicant(page: Page, applicant: StationApplicant): Promise<string> {
  await openSignUp(page);
  return fillInAccount(page, applicant);
}

/**
 * Step 2: the SMS code typed in, and the email link opened on another device (a second browser), which this page
 * notices by itself. Ends on step 3.
 */
export async function confirmPhoneAndEmail(page: Page, browser: Browser, applicant: StationApplicant): Promise<void> {
  const sms = await waitForMessageTo(smsInboxAddress(applicant.phoneNumberE164), /Your Look Up code is [0-9]{6}/);
  await page.getByLabel('6-digit code').fill(pickFrom(sms, /code is ([0-9]{6})/));
  await page.getByRole('button', { name: 'Confirm the code' }).click();
  await expect(page.getByText('Phone confirmed.')).toBeVisible();

  const email = await waitForMessageTo(applicant.email, /verify-email#token=/);
  expect(email.subject).toBe('Confirm your email for Look Up');
  const otherDevice = await browser.newContext();
  try {
    const linkPage = await otherDevice.newPage();
    await linkPage.goto(pickFrom(email, /(http:\/\/localhost:5180\/verify-email#token=[A-Za-z0-9_-]{43})/));
    await expect(linkPage.getByRole('heading', { level: 1, name: 'Your email is confirmed' })).toBeVisible();
    // The token is taken out of the address bar once read.
    expect(new URL(linkPage.url()).hash).toBe('');
  } finally {
    await otherDevice.close();
  }
  const emailPanel = page.getByRole('region', { name: 'Confirm your email' });
  await expect(emailPanel.getByText('Confirmed', { exact: true })).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'About your station' })).toBeVisible();
}

/** Step 3: the station's details and a logo. Ends on step 4. */
export async function describeStation(page: Page, applicant: StationApplicant): Promise<void> {
  await page.getByLabel('Station name').fill(applicant.stationName);
  await page.getByLabel('Frequency').fill(applicant.frequencyLabel);
  await page.getByLabel('Province').selectOption(applicant.province);
  await page.getByLabel('City or town').fill(applicant.city);
  await page.getByLabel(/Add logo/).setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: squareLogoPng() });
  await expect(page.getByRole('img', { name: "Your station's logo" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your broadcasting licence' })).toBeVisible();
}

/** Step 4: the licence number and document, then "Submit for review" (or "Submit again"). Ends on Application status. */
export async function submitLicence(page: Page, applicant: StationApplicant, submitLabel = 'Submit for review'): Promise<void> {
  await page.getByLabel('Licence number').fill(applicant.licenceNumber);
  await page.getByLabel('Licence document').setInputFiles({ name: 'licence.pdf', mimeType: 'application/pdf', buffer: licenceDocumentPdf() });
  await expect(page.getByText('licence.pdf')).toBeVisible();
  await expect(page.getByText('Uploaded', { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel(/I confirm this station holds a valid broadcasting licence/).check();
  await page.getByRole('button', { name: submitLabel }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Thanks — your application is in' })).toBeVisible();
}

/** The whole of sign-up, steps 1 to 4. Returns the new station's id, on the Application status page. */
export async function signUpStation(page: Page, browser: Browser, applicant: StationApplicant): Promise<string> {
  const stationId = await registerApplicant(page, applicant);
  await confirmPhoneAndEmail(page, browser, applicant);
  await describeStation(page, applicant);
  await submitLicence(page, applicant);
  return stationId;
}
