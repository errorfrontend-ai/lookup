import type { ReactNode } from 'react';

/**
 * The label, hint and error around any form control. The error is announced when it appears, and the
 * control is tied to both the hint and the error through aria-describedby (ids come from the caller).
 */
export function FieldFrame({
  controlId,
  label,
  context,
  hint,
  error,
  counter,
  children,
}: {
  controlId: string;
  label: string;
  /**
   * Which of several alike the field belongs to ("Button 2", "Time slot 1"). Read out before the label
   * but not shown, so a screen reader moving from field to field knows which row it is in.
   */
  context?: string;
  hint?: string;
  error?: string | null;
  /** For example "20 / 60": how much of a limit is used. */
  counter?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={controlId} className="text-label">
          {/* The space sits outside the hidden part: some name calculations drop a space at the end of an element. */}
          {context ? <span className="sr-only">{context}</span> : null}
          {context ? ' ' : null}
          {label}
        </label>
        {counter ? <span className="text-caption text-muted">{counter}</span> : null}
      </div>
      {children}
      {hint ? (
        <span id={`${controlId}-hint`} className="text-caption text-muted">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={`${controlId}-error`} role="alert" className="text-caption font-bold text-danger">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** The aria attributes that connect a control to its hint and error. */
export function describedBy(controlId: string, hint?: string, error?: string | null) {
  const ids = [hint ? `${controlId}-hint` : null, error ? `${controlId}-error` : null].filter(Boolean).join(' ');
  return { 'aria-describedby': ids || undefined, 'aria-invalid': error ? true : undefined } as const;
}

export const FIELD_CONTROL_CLASSES =
  'min-h-11 w-full rounded-md border border-line bg-surface px-3 text-body text-ink placeholder:text-muted aria-[invalid=true]:border-2 aria-[invalid=true]:border-danger';
