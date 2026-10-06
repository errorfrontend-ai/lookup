import { afterEach } from 'vitest';

const originalMatchMedia = window.matchMedia;

/**
 * Makes the test browser behave like a wide window (768 px and up) or a phone, for components that
 * choose a layout with useMediaQuery. Restored after every test.
 */
export function setWideScreen(isWide: boolean): void {
  setScreenWidth(isWide ? 768 : 0);
}

/** Makes the test browser behave like a window this many pixels wide: every "(min-width: Npx)" query matches when N is not more. */
export function setScreenWidth(widthInPixels: number): void {
  window.matchMedia = ((query: string) => ({
    matches: Number(/min-width:\s*(\d+)px/.exec(query)?.[1] ?? Number.POSITIVE_INFINITY) <= widthInPixels,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});
