import type { ReactNode } from 'react';
import { Icon } from '../../components/icons';
import { useFocusHeadingOnChange } from '../../components/use-focus-heading-on-change';
import { WIZARD_STEPS, type WizardStepId } from './wizard-steps';

export type SaveStatus = 'nothing-saved' | 'saving' | 'saved' | 'unsaved';

const SAVE_STATUS_WORDS: Record<SaveStatus, string> = {
  'nothing-saved': 'Nothing saved yet',
  saving: 'Saving…',
  saved: 'Draft saved',
  unsaved: 'Changes not saved yet',
};

/**
 * The full-screen frame for setting up an ad: where you are (a step bar on wide screens, "Step 2 of 5"
 * on a phone), whether anything is saved yet, and a footer that stays in reach on a phone. The sidebar
 * is left out so the whole screen is for the task.
 */
export function WizardLayout({
  title,
  clientName,
  isEditing = false,
  currentStep,
  completedSteps,
  saveStatus,
  exitLabel,
  onExit,
  children,
  footer,
}: {
  title: string;
  clientName: string | null;
  /** An ad that is already published is being changed, not set up. */
  isEditing?: boolean;
  currentStep: WizardStepId;
  completedSteps: ReadonlySet<WizardStepId>;
  saveStatus: SaveStatus;
  /** The exit button's name for a screen reader: it says the draft is saved only when that is true. */
  exitLabel: string;
  onExit: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  // A new step starts at its heading, which is announced, rather than on the button that led there.
  useFocusHeadingOnChange(currentStep);
  const currentNumber = WIZARD_STEPS.findIndex((step) => step.id === currentStep) + 1;
  const currentLabel = WIZARD_STEPS[currentNumber - 1]?.label ?? '';

  return (
    <div className="flex min-h-dvh flex-col bg-ground">
      <header className="sticky top-0 z-20 flex flex-col gap-2 border-b border-line-soft bg-surface px-4 pb-3 pt-2 md:px-7">
        <div className="flex min-h-12 items-center gap-3">
          <button type="button" onClick={onExit} aria-label={exitLabel} className="flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-ground">
            <Icon name="close" size={22} />
          </button>
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-caption text-muted">{isEditing ? 'Edit ad' : 'New ad'}{clientName ? ` · ${clientName}` : ''}</span>
            <span className="truncate font-display text-heading">{title}</span>
          </div>
          <ol aria-label="Steps" className="mx-auto hidden list-none items-center gap-1.5 p-0 text-label md:flex">
            {WIZARD_STEPS.map((step, index) => {
              const isCurrent = step.id === currentStep;
              const isDone = completedSteps.has(step.id) && !isCurrent;
              return (
                <li key={step.id} aria-current={isCurrent ? 'step' : undefined} className={`flex items-center gap-2 rounded-pill px-3 py-1.5 font-bold ${isCurrent ? 'bg-accent-soft text-ink' : 'text-muted'}`}>
                  <span className={`flex size-5 items-center justify-center rounded-pill text-caption ${isDone ? 'bg-success text-surface' : isCurrent ? 'bg-accent text-on-accent' : 'bg-line-soft text-muted'}`}>
                    {isDone ? <Icon name="check" size={12} /> : index + 1}
                  </span>
                  {step.label}
                  {isDone ? <span className="sr-only"> (done)</span> : null}
                </li>
              );
            })}
          </ol>
          <span role="status" className={`ml-auto shrink-0 text-caption font-bold ${saveStatus === 'saved' ? 'text-success' : saveStatus === 'unsaved' ? 'text-warning' : 'text-muted'}`}>
            {SAVE_STATUS_WORDS[saveStatus]}
          </span>
        </div>
        <div className="flex flex-col gap-1.5 md:hidden">
          <span className="text-caption font-bold text-muted">
            Step {currentNumber} of {WIZARD_STEPS.length} · {currentLabel}
          </span>
          <div aria-hidden="true" className="grid grid-cols-5 gap-1.5">
            {WIZARD_STEPS.map((step, index) => (
              <div key={step.id} className={`h-1 rounded-sm ${index < currentNumber ? 'bg-accent' : 'bg-line'}`} />
            ))}
          </div>
        </div>
      </header>

      <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 md:px-7 md:py-8">
        {children}
      </main>

      <footer className="sticky bottom-0 z-20 border-t border-line-soft bg-surface px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 md:px-7">
        {footer}
      </footer>
    </div>
  );
}
