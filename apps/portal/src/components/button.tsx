import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover',
  secondary: 'border border-line bg-surface text-ink hover:bg-ground',
  quiet: 'text-ink hover:bg-ground',
  danger: 'border border-danger bg-surface text-danger hover:bg-danger-soft',
};

/** The one look for buttons and for links that act like buttons: at least 44 px tall, 48 px for the main action. */
export function buttonClassName(variant: ButtonVariant = 'primary', extraClassName = ''): string {
  const height = variant === 'primary' ? 'min-h-12' : 'min-h-11';
  return [
    'inline-flex items-center justify-center gap-2 rounded-md px-4 text-label no-underline transition-colors',
    'disabled:cursor-not-allowed disabled:opacity-60 aria-disabled:cursor-not-allowed aria-disabled:opacity-60',
    height,
    VARIANT_CLASSES[variant],
    extraClassName,
  ].join(' ');
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** Shows the work in progress and stops a second press. */
  isBusy?: boolean;
  busyLabel?: string;
}

export function Button({ variant = 'primary', isBusy = false, busyLabel, children, className = '', disabled, type = 'button', ...rest }: ButtonProps) {
  return (
    <button type={type} disabled={disabled || isBusy} aria-busy={isBusy || undefined} className={buttonClassName(variant, className)} {...rest}>
      {isBusy && busyLabel ? busyLabel : children}
    </button>
  );
}

interface ButtonLinkProps extends LinkProps {
  variant?: ButtonVariant;
  children: ReactNode;
}

export function ButtonLink({ variant = 'primary', className = '', children, ...rest }: ButtonLinkProps) {
  return (
    <Link className={buttonClassName(variant, className)} {...rest}>
      {children}
    </Link>
  );
}
