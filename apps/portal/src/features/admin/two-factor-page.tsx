import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { portalApi, SIGNED_IN_USER_QUERY_KEY } from '../../app/portal-api';
import { ApiError } from '../../api/api-client';
import { Button } from '../../components/button';
import { ErrorNotice } from '../../components/error-notice';
import { useSignOut } from '../session/use-sign-out';
import { useSignedInUser } from '../session/use-signed-in-user';

/** "Try again in N minutes" from a RATE_LIMITED answer's wait, when the fifth wrong code is reached. */
export function waitWords(retryAfterSeconds: number | null): string {
  const minutes = Math.max(1, Math.ceil((retryAfterSeconds ?? 900) / 60));
  return `Too many wrong codes. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
}

/**
 * The super admin's code, once per session, before the console opens (P5A design §4.4; P5A-ADMIN-ACCESS-02). The
 * field takes the code as step 2's does.
 */
export function TwoFactorPage() {
  const signedInUser = useSignedInUser();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const signOut = useSignOut();
  const [code, setCode] = useState('');
  const check = useMutation({
    mutationFn: (typed: string) => portalApi.post<void>('/auth/two-factor-code', { code: typed }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: SIGNED_IN_USER_QUERY_KEY });
      void navigate('/admin/applications', { replace: true });
    },
  });
  if (signedInUser.data?.user.platformRole !== 'SUPER_ADMIN') return <Navigate to="/" replace />;
  if (!signedInUser.data.isTwoFactorCodeNeeded && !check.isPending) return <Navigate to="/admin/applications" replace />;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (/^[0-9]{6}$/.test(code)) check.mutate(code);
  };
  const isLimited = check.error instanceof ApiError && check.error.code === 'RATE_LIMITED';

  return (
    <main id="main-content" className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-4 py-10">
      <div className="flex flex-col gap-1">
        <span className="font-display text-title">Look Up</span>
        <h1 className="text-display">Enter the 6-digit code from your authenticator app</h1>
      </div>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="two-factor-code" className="text-label">
            6-digit code
          </label>
          <input
            id="two-factor-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
            className="min-h-12 max-w-48 rounded-md border border-line bg-surface px-3 text-[20px] tracking-[0.3em]"
          />
        </div>
        {isLimited ? (
          <p role="alert" className="text-body font-bold text-danger">
            {waitWords(null)}
          </p>
        ) : check.isError ? (
          <ErrorNotice error={check.error} />
        ) : null}
        <Button type="submit" disabled={code.length !== 6} isBusy={check.isPending} busyLabel="Checking…">
          Continue
        </Button>
        <Button variant="quiet" onClick={() => void signOut()}>
          Sign out
        </Button>
      </form>
    </main>
  );
}
