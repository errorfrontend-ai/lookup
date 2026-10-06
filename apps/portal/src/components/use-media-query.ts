import { useSyncExternalStore } from 'react';

/** Whether a CSS media query matches right now, and updates when the window changes (a phone turned, a window resized). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', notify);
      return () => list.removeEventListener('change', notify);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** md and wider (the portal's "table" layout); below it, cards. */
export const WIDE_SCREEN_QUERY = '(min-width: 768px)';
