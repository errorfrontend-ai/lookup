import type { AdDetail, AdSummary } from '@lookup/contracts';
import type { UploadState } from './ad-upload-store';

export const WIZARD_STEPS = [
  { id: 'client', label: 'Client' },
  { id: 'audio', label: 'Audio' },
  { id: 'buttons', label: 'Buttons' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'review', label: 'Review' },
] as const;

export type WizardStepId = (typeof WIZARD_STEPS)[number]['id'];

/** The steps that can be used so far. The review step is added next; nothing links to a step that is not here. */
export const BUILT_WIZARD_STEPS: ReadonlySet<WizardStepId> = new Set<WizardStepId>(['client', 'audio', 'buttons', 'schedule']);

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

/** Where setup would resume for an ad as the list shows it (the list knows whether buttons and a schedule exist, not what is in them). Null when there is nothing left to set up. */
export function setupStepForSummary(ad: Pick<AdSummary, 'status' | 'hasActionCard' | 'campaign'>): WizardStepId | null {
  if (ad.status === 'AWAITING_UPLOAD' || ad.status === 'FAILED') return 'audio';
  if (!ad.hasActionCard) return 'buttons';
  if (!ad.campaign) return 'schedule';
  if (ad.campaign.displayStatus === 'DRAFT') return 'review';
  return null;
}
