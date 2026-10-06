import { type InputHTMLAttributes, useId } from 'react';
import { describedBy, FIELD_CONTROL_CLASSES, FieldFrame } from './field-frame';

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  hint?: string;
  error?: string | null;
  counter?: string;
}

export function TextField({ label, hint, error, counter, className = '', ...inputProps }: TextFieldProps) {
  const controlId = useId();
  return (
    <FieldFrame controlId={controlId} label={label} hint={hint} error={error} counter={counter}>
      <input id={controlId} className={`${FIELD_CONTROL_CLASSES} ${className}`} {...describedBy(controlId, hint, error)} {...inputProps} />
    </FieldFrame>
  );
}
