import type { Browser, BrowserContext, TestInfo } from '@playwright/test';

/**
 * A second person's browser (the reviewer, an invited member), with this project's screen: a phone run reviews on a
 * phone too. A context made from `browser` does not inherit the project's settings, so they are passed on here.
 */
export function anotherDevice(browser: Browser, testInfo: TestInfo): Promise<BrowserContext> {
  const { baseURL, viewport, isMobile, hasTouch, deviceScaleFactor } = testInfo.project.use;
  return browser.newContext({ baseURL, viewport, isMobile, hasTouch, deviceScaleFactor });
}
