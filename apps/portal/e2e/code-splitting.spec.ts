import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { anotherDevice } from './support/another-device';
import { signInAsSeededOwner } from './support/sign-in';

/**
 * Sign-up and the super admin's console are downloads of their own (P5A-STRUCTURE-05; plan §Mobile D "route-level code
 * splitting"): a station's own pages never fetch them, and the production build keeps them out of the main file.
 */
test.describe('code splitting of the phase 5a areas', () => {
  test('a station’s Ads page loads neither the sign-up nor the console code; the sign-up page loads only its own', async ({ page, browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'Checked once, on the desktop.');
    const fetched: string[] = [];
    page.on('request', (request) => fetched.push(new URL(request.url()).pathname));
    const stationId = await signInAsSeededOwner(page);
    await page.goto(`/stations/${stationId}/ads`);
    await expect(page.getByRole('heading', { level: 1, name: 'Ads' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(fetched.filter((path) => /\/features\/(sign-up|admin)\//.test(path))).toEqual([]);

    const visitor = await anotherDevice(browser, testInfo);
    try {
      const signUp = await visitor.newPage();
      const visitorFetched: string[] = [];
      signUp.on('request', (request) => visitorFetched.push(new URL(request.url()).pathname));
      await signUp.route('https://challenges.cloudflare.com/**', (route) => route.abort());
      await signUp.goto('/signup');
      await expect(signUp.getByRole('heading', { level: 1, name: 'Register your station' })).toBeVisible();
      expect(visitorFetched).toContain('/src/features/sign-up/sign-up-pages.ts');
      expect(visitorFetched.filter((path) => path.startsWith('/src/features/admin/'))).toEqual([]);
    } finally {
      await visitor.close();
    }
  });

  test('the production build puts sign-up and the console in files of their own, and the main file holds neither', async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'Checked once, on the desktop.');
    test.setTimeout(240_000);
    const portalFolder = fileURLToPath(new URL('..', import.meta.url));
    const outputFolder = mkdtempSync(join(tmpdir(), 'lookup-portal-build-'));
    try {
      const vite = join(dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin', 'vite.js');
      execFileSync(process.execPath, [vite, 'build', '--outDir', outputFolder, '--emptyOutDir', '--logLevel', 'error'], {
        cwd: portalFolder,
        stdio: 'pipe',
      });
      const files = readdirSync(join(outputFolder, 'assets')).filter((name) => name.endsWith('.js'));
      expect(files.some((name) => /^sign-up-pages-.+\.js$/.test(name))).toBe(true);
      expect(files.some((name) => /^admin-pages-.+\.js$/.test(name))).toBe(true);
      const html = readFileSync(join(outputFolder, 'index.html'), 'utf8');
      const mainFile = /src="\/assets\/(index-[^"]+\.js)"/.exec(html)?.[1];
      expect(mainFile).toBeDefined();
      const main = readFileSync(join(outputFolder, 'assets', mainFile as string), 'utf8');
      expect(main).not.toContain('About 5 minutes. We save as you go');
      expect(main).not.toContain('Enter the 6-digit code from your authenticator app');
    } finally {
      rmSync(outputFolder, { recursive: true, force: true });
    }
  });
});
