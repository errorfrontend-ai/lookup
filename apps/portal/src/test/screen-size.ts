import { afterEach } from 'vitest';

const originalMatchMedia = window.matchMedia;

/**
 * Makes the test browser behave like a wide window (768 px and up) or a phone, for components that
 * choose a layout with useMediaQuery. Restored after every test.
 */
export function setWideScreen(isWide: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('min-width: 768px') ? isWide : false,
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
