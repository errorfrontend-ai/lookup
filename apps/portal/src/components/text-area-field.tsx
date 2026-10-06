import { type TextareaHTMLAttributes, useId } from 'react';
import { describedBy, FIELD_CONTROL_CLASSES, FieldFrame } from './field-frame';

interface TextAreaFieldProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  label: string;
  hint?: string;
  error?: string | null;
  counter?: string;
}

/** A text box for more than one line, with the same label, hint and error as every other field. */
export function TextAreaField({ label, hint, error, counter, className = '', ...textareaProps }: TextAreaFieldProps) {
  const controlId = useId();
  return (
    <FieldFrame controlId={controlId} label={label} hint={hint} error={error} counter={counter}>
      <textarea id={controlId} rows={3} className={`${FIELD_CONTROL_CLASSES} min-h-24 resize-y py-2 ${className}`} {...describedBy(controlId, hint, error)} {...textareaProps} />
    </FieldFrame>
  );
}
