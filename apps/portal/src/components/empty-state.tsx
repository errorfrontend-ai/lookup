import type { ReactNode } from 'react';
import { Icon, type IconName } from './icons';

/** What a list says when it has nothing to show: why, and (when the person may) what to do next. */
export function EmptyState({ icon, title, children, action }: { icon: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-line bg-surface px-6 py-12 text-center">
      <span className="flex size-12 items-center justify-center rounded-pill bg-accent-soft text-accent">
        <Icon name={icon} size={24} />
      </span>
      <h2 className="text-heading">{title}</h2>
      {children ? <div className="max-w-md text-body text-muted">{children}</div> : null}
      {action}
    </div>
  );
}
