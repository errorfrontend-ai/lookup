import type { StationApplication } from '@lookup/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { portalApi } from '../../app/portal-api';
import { Button } from '../../components/button';
import { ErrorNotice } from '../../components/error-notice';
import { stationApplicationQueryKey, useStationApplication } from './use-station-application';
import { SignUpLayout } from './sign-up-layout';

/** Whole seconds until another code may be sent, or 0. */
export function secondsUntil(isoTime: string | null, now: number): number {
  return isoTime ? Math.max(0, Math.ceil((Date.parse(isoTime) - now) / 1000)) : 0;
}

/** "0:45" */
export function minutesAndSeconds(totalSeconds: number): string {
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

/** Fills the code from the SMS where the browser offers it (WebOTP: the SMS's last line names the portal's host and the code). */
function useCodeFromSms(onCode: (code: string) => void, isWanted: boolean) {
  useEffect(() => {
    const credentials = navigator.credentials as (CredentialsContainer & { get(options: unknown): Promise<unknown> }) | undefined;
    if (!isWanted || !credentials || !('OTPCredential' in window)) return undefined;
    const abort = new AbortController();
    credentials
      .get({ otp: { transport: ['sms'] }, signal: abort.signal })
      .then((credential) => {
        const code = (credential as { code?: unknown } | null)?.code;
        if (typeof code === 'string' && /^[0-9]{6}$/.test(code)) onCode(code);
      })
      .catch(() => undefined);
    return () => abort.abort();
  }, [isWanted, onCode]);
}

/**
 * Step 2, "Check your phone" (P5A design §4.2; P5A-VERIFICATION-01..09): the SMS code, a resend after the minute is
 * up, and the email panel, which updates by itself. Continue needs the phone; the email may wait until submitting.
 */
export function VerifyStep() {
  const { stationId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const application = useStationApplication(stationId, { isPolling: true });
  const [code, setCode] = useState('');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const ticking = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(ticking);
  }, []);
  const refresh = () => queryClient.invalidateQueries({ queryKey: stationApplicationQueryKey(stationId) });

  const checkCode = useMutation({
    mutationFn: (typed: string) => portalApi.post<void>(`/stations/${stationId}/application/phone-verification`, { code: typed }),
    onSuccess: async () => {
      setCode('');
      await refresh();
    },
  });
  const sendCode = useMutation({
    mutationFn: () => portalApi.post<{ sentAt: string | null }>(`/stations/${stationId}/application/phone-verification-codes`),
    onSuccess: () => refresh(),
  });
  const sendLink = useMutation({
    mutationFn: () => portalApi.post<void>(`/stations/${stationId}/application/email-verification-links`),
    onSuccess: () => refresh(),
  });
  useCodeFromSms(setCode, !application.data?.verification.isPhoneVerified);

  if (application.isPending) return <p className="p-6 text-body text-muted">Loading your application…</p>;
  if (application.isError) return <div className="p-6"><ErrorNotice error={application.error} title="We couldn't load your application" /></div>;
  const saved: StationApplication = application.data;
  const { verification } = saved;
  const wait = secondsUntil(verification.phoneCodeResendAvailableAt, now);

  const submitCode = (event: FormEvent) => {
    event.preventDefault();
    if (/^[0-9]{6}$/.test(code)) checkCode.mutate(code);
  };

  return (
    <SignUpLayout
      step="verify"
      heading="Check your phone"
      onBack={() => void navigate(`/stations/${stationId}/application/account`)}
      footer={
        <Button
          className="w-full min-h-13"
          disabled={!verification.isPhoneVerified}
          onClick={() => void navigate(`/stations/${stationId}/application/details`)}
        >
          Continue
        </Button>
      }
    >
      {verification.isPhoneVerified ? (
        <p className="text-body">
          <strong>Phone confirmed.</strong> {saved.account.mobileNumber}
        </p>
      ) : (
        <form onSubmit={submitCode} noValidate className="flex flex-col gap-3">
          <p className="text-body">We sent a 6-digit code by SMS to {saved.account.mobileNumber}.</p>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="sign-up-code" className="text-label">
              6-digit code
            </label>
            <input
              id="sign-up-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              pattern="[0-9]{6}"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
              className="min-h-12 max-w-48 rounded-md border border-line bg-surface px-3 text-[20px] tracking-[0.3em]"
            />
          </div>
          {checkCode.isError ? <ErrorNotice error={checkCode.error} /> : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="secondary" disabled={code.length !== 6} isBusy={checkCode.isPending} busyLabel="Checking…">
              Confirm the code
            </Button>
            <span className="text-body text-muted">Didn't get it?</span>
            {wait > 0 ? (
              <span aria-live="polite" className="text-body text-muted">
                Resend in {minutesAndSeconds(wait)}
              </span>
            ) : (
              <Button variant="quiet" onClick={() => sendCode.mutate()} isBusy={sendCode.isPending} busyLabel="Sending…">
                Send a new code
              </Button>
            )}
          </div>
          {sendCode.isError ? <ErrorNotice error={sendCode.error} /> : null}
        </form>
      )}

      <section aria-labelledby="sign-up-email-heading" className="flex flex-col gap-2 rounded-md border border-line p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 id="sign-up-email-heading" className="text-title">
            Confirm your email
          </h2>
          <span className={`rounded-pill px-3 py-1 text-caption font-bold ${verification.isEmailVerified ? 'bg-success-soft text-success' : 'bg-ground text-muted'}`}>
            {verification.isEmailVerified ? 'Confirmed' : 'Waiting'}
          </span>
        </div>
        {verification.isEmailVerified ? null : (
          <>
            <p className="text-body">We sent a link to {saved.account.email}. Open it on any device — this page updates by itself.</p>
            <div className="flex flex-wrap gap-3">
              <Button variant="quiet" onClick={() => sendLink.mutate()} isBusy={sendLink.isPending} busyLabel="Sending…">
                Send the link again
              </Button>
              {application.isPollingStopped ? (
                <Button variant="quiet" onClick={application.checkAgain}>
                  Check again
                </Button>
              ) : null}
            </div>
            {sendLink.isSuccess ? <p className="text-caption text-muted">Sent. It can take a minute to arrive.</p> : null}
            {sendLink.isError ? <ErrorNotice error={sendLink.error} /> : null}
          </>
        )}
      </section>
    </SignUpLayout>
  );
}
