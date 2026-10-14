import type { Page } from '@playwright/test';
import axe from 'axe-core';

/**
 * Every control on the page that is too small to tap reliably: under 44 px tall (the plan's minimum,
 * stricter than WCAG's 24 px). A link inside a sentence is exempt, as WCAG allows; a radio button or
 * tick box counts by the label it sits in, which is what a finger actually presses.
 */
export async function controlsTooSmallToTap(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const smallest = 44 - 0.5;
    const controls = [...document.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [role="button"]')];
    return controls.flatMap((control) => {
      const style = getComputedStyle(control);
      if (control.tagName === 'A' && style.display === 'inline') return [];
      const target = control instanceof HTMLInputElement && (control.type === 'radio' || control.type === 'checkbox') ? (control.closest('label') ?? control) : control;
      const box = target.getBoundingClientRect();
      // Not on screen, or visually hidden (a file box behind its button, a skip link until it is focused).
      if (box.width <= 1 || box.height <= 1 || style.visibility === 'hidden' || control.closest('[hidden]')) return [];
      if (box.height >= smallest) return [];
      const name = control.getAttribute('aria-label') ?? control.textContent?.trim() ?? control.tagName;
      return [`${control.tagName.toLowerCase()} "${name.slice(0, 40)}" is ${Math.round(box.height)} px tall`];
    });
  });
}

/** Presses Tab through the page and lists every control that takes focus without a visible outline. */
export async function focusWithoutVisibleOutline(page: Page, presses: number): Promise<string[]> {
  const problems: string[] = [];
  for (let press = 0; press < presses; press += 1) {
    await page.keyboard.press('Tab');
    const problem = await page.evaluate(() => {
      const focused = document.activeElement as HTMLElement | null;
      if (!focused || focused === document.body) return null;
      // Focus has moved into a frame's own document (the licence preview: the browser's PDF viewer), which this page
      // cannot see into. The viewer rings its own buttons, as screenshots of each Tab showed on 14 October 2026.
      if (focused.tagName === 'IFRAME') return null;
      const style = getComputedStyle(focused);
      const isVisible = style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) >= 2;
      return isVisible ? null : `${focused.tagName.toLowerCase()} "${(focused.getAttribute('aria-label') ?? focused.textContent ?? '').trim().slice(0, 40)}"`;
    });
    if (problem) problems.push(problem);
  }
  return problems;
}

/**
 * What axe finds wrong with the page as drawn, one line per problem, in a real browser, so colour contrast is
 * measured too (jsdom cannot). The licence preview frame is a PDF in the browser's own viewer, which axe cannot
 * enter; the frame itself is still checked (its title).
 */
export async function accessibilityProblems(page: Page): Promise<string[]> {
  await page.evaluate(axe.source);
  return page.evaluate(async () => {
    const found = await (window as unknown as { axe: typeof axe }).axe.run(document, { resultTypes: ['violations'], iframes: false });
    return found.violations.map((violation) => `${violation.id}: ${violation.help} — ${violation.nodes.slice(0, 3).map((node) => node.target.join(' ')).join(' | ')}`);
  });
}

/** The plan's widths (Mobile D): the page must fit each one with no sideways scrolling. */
export const CHECKED_WIDTHS = [320, 375, 768, 1024, 1280] as const;

/** The widths at which the page is wider than the screen, so a person would have to scroll sideways. */
export async function widthsThatScrollSideways(page: Page): Promise<string[]> {
  const original = page.viewportSize();
  const problems: string[] = [];
  for (const width of CHECKED_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    // A frame to lay out again before measuring.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 0) problems.push(`${width} px: ${overflow} px too wide`);
  }
  if (original) await page.setViewportSize(original);
  return problems;
}
