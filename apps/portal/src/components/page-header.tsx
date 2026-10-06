import type { ReactNode } from 'react';
import { Link } from 'react-router';

export interface BreadcrumbStep {
  label: string;
  to?: string;
}

/** The top of a page: where you are, what it is, and the main thing you can do here. */
export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  breadcrumb?: BreadcrumbStep[];
}) {
  return (
    <header className="flex flex-col gap-3">
      {breadcrumb?.length ? (
        <nav aria-label="Breadcrumb" className="text-label text-muted">
          {breadcrumb.map((step, index) => (
            <span key={step.label}>
              {index > 0 ? <span aria-hidden="true"> / </span> : null}
              {step.to ? (
                <Link to={step.to} className="text-accent hover:underline">
                  {step.label}
                </Link>
              ) : (
                <span aria-current="page">{step.label}</span>
              )}
            </span>
          ))}
        </nav>
      ) : null}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-display">{title}</h1>
          {description ? <p className="text-body text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}
