import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { portalApi } from '../../app/portal-api';
import { ApiError } from '../../api/api-client';
import { LoadingScreen } from '../../components/plain-pages';

/** The token from "#token=…": a fragment never reaches a server, so it stays out of every access log. */
export function linkTokenFrom(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('token');
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

/**
 * Where the email link lands (P5A design §4.1; P5A-VERIFICATION-09), on any device, signed in or not. It reads the
 * token once, takes it out of the address bar, and confirms the email.
 */
export function VerifyEmailPage() {
  const [token] = useState(() => linkTokenFrom(window.location.hash));
  const confirm = useMutation({ mutationFn: (linkToken: string) => portalApi.post<void>('/registration/email-verifications', { token: linkToken }) });
  const mutate = confirm.mutate;
  // Once, on arrival (a second run in development's strict mode sends nothing more).
  const hasSent = useRef(false);
  useEffect(() => {
    window.history.replaceState(null, '', window.location.pathname);
    if (token && !hasSent.current) {
      hasSent.current = true;
      mutate(token);
    }
  }, [token, mutate]);

  if (token && (confirm.isIdle || confirm.isPending)) return <LoadingScreen label="Confirming your email…" />;
  const code = confirm.error instanceof ApiError ? confirm.error.code : null;
  const isConfirmed = confirm.isSuccess;
  return (
    <main id="main-content" className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 px-4">
      <span className="font-display text-title">Look Up</span>
      <h1 className="text-display">{isConfirmed ? 'Your email is confirmed' : code === 'EMAIL_LINK_EXPIRED' ? 'This link has expired' : "This link doesn't work"}</h1>
      <p className="text-body text-muted">
        {isConfirmed
          ? 'You can close this page, or go back to your application: it updates by itself.'
          : confirm.error instanceof ApiError
            ? confirm.error.message
            : token
              ? "We couldn't reach Look Up. Check your connection, then open the link again."
              : 'Open the link from the email again, or ask for a new one on the sign-up page.'}
      </p>
      <Link to="/" className="text-label text-accent underline underline-offset-4">
        Go to your application
      </Link>
    </main>
  );
}
