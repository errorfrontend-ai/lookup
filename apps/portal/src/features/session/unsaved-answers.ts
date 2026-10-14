import { useEffect, useRef } from 'react';

/**
 * What a person typed on a sign-up step but has not saved yet, kept while they go Back and come forward again
 * (P5A-SIGNUP-SCREENS-04). It lives beside the session, which forgets it all on signing out. It is kept in this tab's
 * memory only: never written to the browser's storage, and gone on a reload, when the saved application is the truth.
 */
const drafts = new Map<string, Record<string, string>>();
const keyOf = (stationId: string, step: string) => `${stationId}:${step}`;

/** Forgets every unsaved answer: on signing out, so the next person on a shared computer never sees them. */
export function forgetAllDrafts(): void {
  drafts.clear();
}

/** The step's unsaved answers, if the person left it with some. */
export function draftFor(stationId: string, step: string): Record<string, string> | undefined {
  return drafts.get(keyOf(stationId, step));
}

/**
 * Keeps the typed answers when the step is left, if they differ from the saved ones and were not saved since: in
 * every other case the saved application is used next time.
 */
export function useKeepDraftOnLeaving(stationId: string, step: string, typed: Record<string, string>, saved: Record<string, string>): { markSaved: () => void } {
  const latest = useRef({ typed, saved });
  latest.current = { typed, saved };
  const isSaved = useRef(false);
  useEffect(
    () => () => {
      const { typed: lastTyped, saved: lastSaved } = latest.current;
      const isChanged = Object.keys(lastTyped).some((field) => lastTyped[field] !== (lastSaved[field] ?? ''));
      if (isSaved.current || !isChanged) drafts.delete(keyOf(stationId, step));
      else drafts.set(keyOf(stationId, step), lastTyped);
    },
    [stationId, step],
  );
  return {
    markSaved: () => {
      isSaved.current = true;
    },
  };
}
