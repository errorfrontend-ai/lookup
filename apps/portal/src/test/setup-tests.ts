import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// How long findBy… and waitFor keep looking before failing. The 1 s default is too short for a whole
// page to draw on the build machine (4 CPUs, little memory) while other test files run beside it; a real
// failure still fails, only a few seconds later.
configure({ asyncUtilTimeout: 6_000 });

afterEach(() => {
  cleanup();
});

// jsdom has no media playback, object URLs, scrolling or media queries; the portal's screens use all four.
HTMLMediaElement.prototype.play = () => Promise.resolve();
HTMLMediaElement.prototype.pause = () => undefined;
URL.createObjectURL = () => 'blob:test-object-url';
URL.revokeObjectURL = () => undefined;
Element.prototype.scrollIntoView = () => undefined;
window.matchMedia = (query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }) as MediaQueryList;
