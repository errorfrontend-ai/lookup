import { type SelectHTMLAttributes, useId } from 'react';
import { describedBy, FIELD_CONTROL_CLASSES, FieldFrame } from './field-frame';

interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  label: string;
  hint?: string;
  error?: string | null;
}

export function SelectField({ label, hint, error, children, className = '', ...selectProps }: SelectFieldProps) {
  const controlId = useId();
  return (
    <FieldFrame controlId={controlId} label={label} hint={hint} error={error}>
      <select id={controlId} className={`${FIELD_CONTROL_CLASSES} ${className}`} {...describedBy(controlId, hint, error)} {...selectProps}>
        {children}
      </select>
    </FieldFrame>
  );
}
