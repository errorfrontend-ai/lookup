import { Link } from 'react-router';

/** Shown while the portal checks who is signed in. Kept quiet so a fast answer doesn't flash. */
export function LoadingScreen({ label = 'Loading…' }: { label?: string }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4" aria-busy="true">
      <p className="text-body text-muted" role="status">
        {label}
      </p>
    </main>
  );
}

export function NotFoundPage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 px-4">
      <h1 className="text-title">We couldn't find that page</h1>
      <p className="text-body text-muted">The link may be out of date, or it belongs to a station you're not part of.</p>
      <Link to="/" className="text-label text-accent underline underline-offset-4">
        Go to your ads
      </Link>
    </main>
  );
}

export function NoStationPage({ onSignOut }: { onSignOut: () => void }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 px-4">
      <h1 className="text-title">You're not part of a station yet</h1>
      <p className="text-body text-muted">Ask your station's owner to add you, then sign in again.</p>
      <button type="button" onClick={onSignOut} className="min-h-11 self-start rounded-md border border-line px-4 text-label">
        Sign out
      </button>
    </main>
  );
}
