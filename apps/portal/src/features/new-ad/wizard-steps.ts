import type { AdDetail } from '@lookup/contracts';
import type { UploadState } from './ad-upload-store';

export const WIZARD_STEPS = [
  { id: 'client', label: 'Client' },
  { id: 'audio', label: 'Audio' },
  { id: 'buttons', label: 'Buttons' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'review', label: 'Review' },
] as const;

export type WizardStepId = (typeof WIZARD_STEPS)[number]['id'];

export function isWizardStepId(value: string | null): value is WizardStepId {
  return WIZARD_STEPS.some((step) => step.id === value);
}

/**
 * Where setup should resume for an ad: the audio if it hasn't arrived (and isn't on its way), then the
 * buttons, then the schedule, then the review. An upload that is going up or being checked counts as
 * arrived, so the person can carry on while it finishes.
 */
export function firstIncompleteStep(ad: Pick<AdDetail, 'status' | 'actionCard' | 'schedule'> | null, upload: Pick<UploadState, 'phase'> | undefined): WizardStepId {
  if (!ad) return 'client';
  const audioIsOnItsWay = upload?.phase === 'uploading' || upload?.phase === 'checking' || upload?.phase === 'checked';
  if ((ad.status === 'AWAITING_UPLOAD' && !audioIsOnItsWay) || ad.status === 'FAILED') return 'audio';
  if (!ad.actionCard) return 'buttons';
  if (!ad.schedule) return 'schedule';
  return 'review';
}
