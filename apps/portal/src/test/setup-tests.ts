import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

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
