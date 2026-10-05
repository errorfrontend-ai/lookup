import { ApiError } from '../api/api-client';

/**
 * A failure explained in plain words, with the reference code a station can quote to support (the
 * request id, which finds the full detail in the logs). Never shows technical text.
 */
export function ErrorNotice({ error, title }: { error: unknown; title?: string }) {
  const apiError = error instanceof ApiError ? error : null;
  const message = apiError?.message ?? 'Something went wrong. Please try again.';
  return (
    <div role="alert" className="flex flex-col gap-1 rounded-md border border-danger bg-danger-soft px-4 py-3 text-danger">
      {title ? <strong className="text-label">{title}</strong> : null}
      <span className="text-body">{message}</span>
      {apiError ? (
        <span className="text-caption">
          Reference: <code className="font-mono">{apiError.requestId}</code>
        </span>
      ) : null}
    </div>
  );
}
