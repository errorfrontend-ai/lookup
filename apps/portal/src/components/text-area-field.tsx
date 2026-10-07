import { type TextareaHTMLAttributes, useId } from 'react';
import { describedBy, FIELD_CONTROL_CLASSES, FieldFrame } from './field-frame';

interface TextAreaFieldProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  label: string;
  /** Which of several alike the field belongs to, read out before the label (see FieldFrame). */
  context?: string;
  hint?: string;
  error?: string | null;
  counter?: string;
}

/** A text box for more than one line, with the same label, hint and error as every other field. */
export function TextAreaField({ label, context, hint, error, counter, className = '', ...textareaProps }: TextAreaFieldProps) {
  const controlId = useId();
  return (
    <FieldFrame controlId={controlId} label={label} context={context} hint={hint} error={error} counter={counter}>
      <textarea id={controlId} rows={3} className={`${FIELD_CONTROL_CLASSES} min-h-24 resize-y py-2 ${className}`} {...describedBy(controlId, hint, error)} {...textareaProps} />
    </FieldFrame>
  );
}
