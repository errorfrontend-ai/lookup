import type { AdDetail, ScheduleInput } from '@lookup/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../api/api-client';
import { portalApi } from '../../app/portal-api';
import { refreshAfterAdChange } from '../ads/use-ad-detail';
import {
  draftFromSchedule,
  newScheduleDraft,
  problemsFromApiFields,
  type ScheduleDraft,
  type ScheduleProblems,
  sameSchedule,
  todayInTimeZone,
  validateSchedule,
} from './schedule-draft';

/**
 * Saves when the ad airs. The ad's own page gets the saved version straight away. A campaign that is
 * already published keeps airing, now by the new times.
 */
export function useSaveSchedule(stationId: string, adId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (schedule: ScheduleInput) => portalApi.put<AdDetail>(`/stations/${stationId}/ads/${adId}/schedule`, schedule),
    onSuccess: (updatedDetail) => refreshAfterAdChange(queryClient, stationId, adId, updatedDetail),
  });
}

const NO_PROBLEMS: ScheduleProblems = { slots: new Map() };

/** What a draft says apart from the keys that only tell its slots apart, so "was anything changed" ignores them. */
function signature(draft: ScheduleDraft): string {
  return JSON.stringify({ ...draft, slots: draft.slots.map(({ days, from, to }) => ({ days: [...days].sort(), from, to })) });
}

/**
 * The schedule being edited for one ad: what was chosen and typed, whether it differs from what is
 * saved, what is wrong with it, and saving it. It starts from the saved schedule (or, for an ad with
 * none, from today for four weeks) once the ad and the station's time zone are known, and is then the
 * person's own: a refresh of the ad in the background never overwrites what they are choosing.
 */
export function useScheduleDraft(stationId: string, adId: string | undefined, detail: AdDetail | undefined, stationTimeZone: string | undefined) {
  const saveSchedule = useSaveSchedule(stationId, adId ?? '');
  const timeZone = detail?.schedule?.stationTimeZone ?? stationTimeZone;
  const today = useMemo(() => (timeZone ? todayInTimeZone(timeZone) : null), [timeZone]);

  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  const initialSignature = useRef<string | null>(null);
  const [apiProblems, setApiProblems] = useState<ScheduleProblems>(NO_PROBLEMS);
  const [showAllProblems, setShowAllProblems] = useState(false);

  useEffect(() => {
    if (draft !== null || !detail || !today) return;
    const initial = detail.schedule ? draftFromSchedule(detail.schedule) : newScheduleDraft(today);
    initialSignature.current = signature(initial);
    setDraft(initial);
  }, [draft, detail, today]);

  const currentDraft = useMemo(() => draft ?? newScheduleDraft(today ?? '1970-01-01'), [draft, today]);
  const validation = useMemo(() => validateSchedule(currentDraft, today ?? '1970-01-01'), [currentDraft, today]);

  const isDirty = useMemo(() => {
    if (draft === null || !detail) return false;
    return validation.input ? !sameSchedule(validation.input, detail.schedule) : signature(draft) !== initialSignature.current;
  }, [draft, detail, validation.input]);

  // Closing the tab with unsaved times asks first.
  useEffect(() => {
    if (!isDirty) return undefined;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [isDirty]);

  const { reset: resetSave } = saveSchedule;
  const changeDraft = useCallback(
    (next: ScheduleDraft) => {
      setDraft(next);
      // What the last save complained about is about the old schedule.
      setApiProblems(NO_PROBLEMS);
      resetSave();
    },
    [resetSave],
  );

  /** Saves the schedule and returns the ad as it is now. Null when it was not saved: the problems are shown, and nothing was sent (or the API's problems are shown). */
  const save = useCallback(async (): Promise<AdDetail | null> => {
    if (!validation.input) {
      setShowAllProblems(true);
      return null;
    }
    try {
      const updated = await saveSchedule.mutateAsync(validation.input);
      setApiProblems(NO_PROBLEMS);
      return updated;
    } catch (error) {
      if (error instanceof ApiError) setApiProblems(problemsFromApiFields(currentDraft, error.fields));
      return null;
    }
  }, [validation.input, saveSchedule, currentDraft]);

  return {
    draft: currentDraft,
    isReady: draft !== null,
    changeDraft,
    validation,
    isDirty,
    hasSavedSchedule: Boolean(detail?.schedule),
    save,
    isSaving: saveSchedule.isPending,
    saveError: saveSchedule.error,
    apiProblems,
    showAllProblems,
    today: today ?? '',
    timeZone: timeZone ?? '',
  };
}
