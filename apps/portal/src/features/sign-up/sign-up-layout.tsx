import type { ApplicationStep } from '@lookup/contracts';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Icon } from '../../components/icons';
import { useFocusHeadingOnChange } from '../../components/use-focus-heading-on-change';
import { SIGN_UP_STEP_NAMES, SIGN_UP_STEP_NUMBERS } from '../../plain-words/sign-up-words';

/**
 * Every sign-up step's frame (P5A design §4.2): step 1 shows "Look Up · for stations" and "Sign in"; later steps a
 * 48 × 48 Back button. Under it, "Step N of 4 · <name>" and a four-part bar (decorative: the words say it). One
 * column on a phone, a centred card from lg; the main button sticks to the bottom on a phone.
 */
export function SignUpLayout({
  step,
  heading,
  intro,
  onBack,
  children,
  footer,
}: {
  step: ApplicationStep;
  heading: string;
  intro?: ReactNode;
  onBack?: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  const number = SIGN_UP_STEP_NUMBERS[step];
  useFocusHeadingOnChange(step);
  return (
    <div className="flex min-h-dvh flex-col bg-ground">
      <header className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-2 sm:px-6">
        {onBack ? (
          <button type="button" onClick={onBack} aria-label="Back" className="inline-flex size-12 items-center justify-center rounded-md hover:bg-ground">
            <Icon name="back" size={24} />
          </button>
        ) : (
          <span className="flex items-baseline gap-2">
            <span className="font-display text-title">Look Up</span>
            <span className="text-caption text-muted">for stations</span>
          </span>
        )}
        {number === 1 && !onBack ? (
          <Link to="/sign-in" className="text-label text-accent underline underline-offset-4">
            Sign in
          </Link>
        ) : null}
      </header>
      <main id="main-content" className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5 px-4 pb-28 pt-5 sm:px-6 lg:pb-10">
        <div className="flex flex-col gap-2">
          <p className="text-caption text-muted">
            Step {number} of 4 · {SIGN_UP_STEP_NAMES[step]}
          </p>
          <div aria-hidden="true" className="grid grid-cols-4 gap-1">
            {[1, 2, 3, 4].map((part) => (
              <span key={part} className={`h-1.5 rounded-pill ${part <= number ? 'bg-accent' : 'bg-line-soft'}`} />
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <h1 className="text-display focus:outline-none">
            {heading}
          </h1>
          {intro ? <div className="text-body text-muted">{intro}</div> : null}
        </div>
        <div className="flex flex-col gap-5 rounded-lg border border-line bg-surface p-4 sm:p-6">{children}</div>
        <div className="fixed inset-x-0 bottom-0 border-t border-line bg-surface p-3 lg:static lg:border-0 lg:bg-transparent lg:p-0">{footer}</div>
      </main>
    </div>
  );
}
