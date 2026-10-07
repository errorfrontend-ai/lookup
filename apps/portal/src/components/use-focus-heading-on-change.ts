import { useEffect, useRef } from 'react';

/**
 * Moves focus to the page's main heading whenever `key` changes (a new page, a new step), but not on
 * first arrival. In a single-page app nothing is announced when the content changes, so without this a
 * screen reader stays silent and a keyboard user is left on a control that may no longer exist. When
 * the heading is not drawn yet (its data is still loading) the main area takes focus instead.
 */
export function useFocusHeadingOnChange(key: string): void {
  const isFirstArrival = useRef(true);
  useEffect(() => {
    if (isFirstArrival.current) {
      isFirstArrival.current = false;
      return;
    }
    const main = document.getElementById('main-content');
    const target = main?.querySelector<HTMLElement>('h1') ?? main;
    if (!target) return;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus();
  }, [key]);
}
