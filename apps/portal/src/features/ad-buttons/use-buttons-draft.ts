import type { AdDetail } from '@lookup/contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../api/api-client';
import { type ButtonDraft, draftsFromCard } from './button-draft';
import { useSaveActionCard } from './use-save-action-card';
import { type ButtonFieldProblems, problemsFromApiFields, validateButtonDrafts } from './validate-button-drafts';

/** JSON with the keys in a fixed order, so two cards that say the same thing compare equal (the database keeps keys in its own order). */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([first], [second]) => (first < second ? -1 : 1))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const NO_PROBLEMS: ReadonlyMap<string, ButtonFieldProblems> = new Map();

/**
 * The buttons being edited for one ad: what was typed, whether it differs from what is saved, what
 * is wrong with it, and saving it. The drafts start from the saved card once the ad has loaded and
 * are then the person's own until they save; a refresh of the ad in the background never overwrites
 * what they are typing.
 */
export function useButtonsDraft(stationId: string, adId: string | undefined, detail: AdDetail | undefined) {
  const saveActionCard = useSaveActionCard(stationId, adId ?? '');
  const [drafts, setDrafts] = useState<ButtonDraft[] | null>(null);
  const [apiProblems, setApiProblems] = useState<ReadonlyMap<string, ButtonFieldProblems>>(NO_PROBLEMS);
  const [showAllProblems, setShowAllProblems] = useState(false);

  const savedDrafts = useMemo(() => (detail ? draftsFromCard(detail.actionCard) : null), [detail]);
  /** False when the saved card is in a form this page cannot read: editing it here would lose what it could not read. */
  const canEdit = savedDrafts !== null;

  useEffect(() => {
    if (drafts === null && savedDrafts !== null) setDrafts(savedDrafts);
  }, [drafts, savedDrafts]);

  const currentDrafts = useMemo(() => drafts ?? [], [drafts]);
  const validation = useMemo(() => validateButtonDrafts(currentDrafts), [currentDrafts]);

  const isDirty = useMemo(() => {
    if (drafts === null || savedDrafts === null || !detail) return false;
    // A card that can be built is compared as a card (so "0977 123 456" saved as +260 97 712 3456 is not a change);
    // one that cannot be built yet differs unless it is exactly what was loaded.
    return validation.card ? canonicalJson(validation.card) !== canonicalJson(detail.actionCard) : canonicalJson(drafts) !== canonicalJson(savedDrafts);
  }, [drafts, savedDrafts, detail, validation.card]);

  // Closing the tab with unsaved buttons asks first.
  useEffect(() => {
    if (!isDirty) return undefined;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [isDirty]);

  const { reset: resetSave } = saveActionCard;
  const changeDrafts = useCallback(
    (next: ButtonDraft[]) => {
      setDrafts(next);
      // What the last save complained about is about the old buttons.
      setApiProblems(NO_PROBLEMS);
      resetSave();
    },
    [resetSave],
  );

  /** Saves the buttons. Returns whether they are now saved; if not, the problems are shown and nothing was sent (or the API's problems are shown). */
  const save = useCallback(async (): Promise<boolean> => {
    if (!validation.card) {
      setShowAllProblems(true);
      return false;
    }
    try {
      await saveActionCard.mutateAsync(validation.card);
      setApiProblems(NO_PROBLEMS);
      return true;
    } catch (error) {
      if (error instanceof ApiError) setApiProblems(problemsFromApiFields(currentDrafts, error.fields));
      return false;
    }
  }, [validation.card, saveActionCard, currentDrafts]);

  return {
    drafts: currentDrafts,
    isReady: drafts !== null,
    canEdit,
    changeDrafts,
    validation,
    isDirty,
    hasSavedCard: Boolean(detail?.actionCard),
    save,
    isSaving: saveActionCard.isPending,
    saveError: saveActionCard.error,
    apiProblems,
    showAllProblems,
  };
}
