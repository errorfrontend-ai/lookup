import { useEffect, useRef, useState } from 'react';
import { HUMAN_CHECK_SITE_KEY } from '../../app/portal-settings';

/** The part of Cloudflare Turnstile's browser API the sign-up uses. */
export interface TurnstileApi {
  render(
    element: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      theme: 'auto';
      callback: (token: string) => void;
      'expired-callback': () => void;
      'error-callback': () => void;
    },
  ): string;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

/** Loaded only on sign-up step 1 (P5A design §4.2), and only once. */
const SCRIPT_ADDRESS = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const LOAD_TIMEOUT_MILLISECONDS = 15_000;
let loading: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_ADDRESS;
    script.async = true;
    const giveUp = window.setTimeout(() => reject(new Error('the human check did not load in time')), LOAD_TIMEOUT_MILLISECONDS);
    script.onload = () => {
      window.clearTimeout(giveUp);
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error('the human check loaded without its API'));
    };
    script.onerror = () => {
      window.clearTimeout(giveUp);
      reject(new Error('the human check could not load'));
    };
    document.head.append(script);
  }).catch((problem: unknown) => {
    // A failed load may be tried again ("Try again").
    loading = null;
    document.querySelector(`script[src="${SCRIPT_ADDRESS}"]`)?.remove();
    throw problem;
  });
  return loading;
}

/**
 * The human check above "Continue" on step 1 (P5A-SIGNUP-08, P5A-D8). It hands its token up when solved, and null
 * when the token expires or the check fails. If Cloudflare's script cannot load, it says so and offers "Try again".
 */
export function HumanCheckWidget({ onToken }: { onToken: (token: string | null) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [attempt, setAttempt] = useState(0);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    let widgetId: string | null = null;
    let isCurrent = true;
    setState('loading');
    loadTurnstile()
      .then((turnstile) => {
        if (!isCurrent || !container.current) return;
        widgetId = turnstile.render(container.current, {
          sitekey: HUMAN_CHECK_SITE_KEY,
          action: 'station-sign-up',
          theme: 'auto',
          callback: (token) => onTokenRef.current(token),
          'expired-callback': () => onTokenRef.current(null),
          'error-callback': () => onTokenRef.current(null),
        });
        setState('ready');
      })
      .catch(() => {
        if (isCurrent) setState('failed');
      });
    return () => {
      isCurrent = false;
      if (widgetId !== null) window.turnstile?.remove(widgetId);
    };
  }, [attempt]);

  return (
    <div className="flex flex-col gap-2">
      <div ref={container} className="min-h-16" />
      {state === 'loading' ? <p className="text-caption text-muted">Loading the human check…</p> : null}
      {state === 'failed' ? (
        <div role="alert" className="flex flex-col items-start gap-2">
          <p className="text-body">The human check couldn't load. Check your connection, then try again.</p>
          <button type="button" onClick={() => setAttempt((count) => count + 1)} className="min-h-11 rounded-md border border-line px-4 text-label">
            Try again
          </button>
        </div>
      ) : null}
    </div>
  );
}
