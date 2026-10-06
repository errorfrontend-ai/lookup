import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'outline';

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-ink/10 text-ink',
  accent: 'bg-accent text-on-accent',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  outline: 'border border-line bg-surface text-muted',
};

/** A short status label. Colour never carries the meaning alone: the words do. */
export function Badge({ tone = 'neutral', children, className = '' }: { tone?: BadgeTone; children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-pill px-2.5 py-0.5 text-caption font-bold ${TONE_CLASSES[tone]} ${className}`}>
      {children}
    </span>
  );
}
