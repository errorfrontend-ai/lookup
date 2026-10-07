import type { Page } from '@playwright/test';

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
      const style = getComputedStyle(focused);
      const isVisible = style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) >= 2;
      return isVisible ? null : `${focused.tagName.toLowerCase()} "${(focused.getAttribute('aria-label') ?? focused.textContent ?? '').trim().slice(0, 40)}"`;
    });
    if (problem) problems.push(problem);
  }
  return problems;
}
