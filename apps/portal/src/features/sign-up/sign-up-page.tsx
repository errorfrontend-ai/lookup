import type { RegisteredStationApplicant, SignedInPortalUser } from '@lookup/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { portalApi, SIGNED_IN_USER_QUERY_KEY } from '../../app/portal-api';
import { ApiError } from '../../api/api-client';
import { Button } from '../../components/button';
import { ErrorNotice } from '../../components/error-notice';
import { TextField } from '../../components/text-field';
import { fieldErrorsFrom, fieldReasonWords } from '../../plain-words/sign-up-words';
import { useSignedInUser } from '../session/use-signed-in-user';
import { homePathFor } from '../sign-in/sign-in-page';
import { HumanCheckWidget } from './human-check-widget';
import { stationApplicationQueryKey } from './use-station-application';
import { SignUpLayout } from './sign-up-layout';

const PASSWORD_MINIMUM_CHARACTERS = 15;

/**
 * Step 1, "Register your station" (P5A design §4.2; P5A-SIGNUP-04..08): name, work email, a Zambian mobile number
 * after a fixed +260, and a password of at least 15 characters (checked as typed for length; the API checks the
 * rest), behind the human check. It creates the account and the station and signs the person in.
 */
export function SignUpPage() {
  const signedInUser = useSignedInUser();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [mobileNumber, setMobileNumber] = useState('');
  const [password, setPassword] = useState('');
  const [isPasswordLeft, setIsPasswordLeft] = useState(false);
  const [humanCheckToken, setHumanCheckToken] = useState<string | null>(null);

  const register = useMutation({
    mutationFn: () =>
      portalApi.post<SignedInPortalUser & RegisteredStationApplicant>('/registration/applicants', {
        fullName,
        email,
        mobileNumber,
        password,
        humanCheckToken,
      }),
    onSuccess: (registered) => {
      const { stationId, ...signedIn } = registered;
      queryClient.setQueryData(SIGNED_IN_USER_QUERY_KEY, signedIn);
      void queryClient.invalidateQueries({ queryKey: stationApplicationQueryKey(stationId) });
      setPassword('');
      void navigate(`/stations/${stationId}/application/verify`, { replace: true });
    },
  });

  if (signedInUser.data && !register.isSuccess) return <Navigate to={homePathFor(signedInUser.data)} replace />;

  const fieldErrors = fieldErrorsFrom(register.error);
  const isEmailTaken = register.error instanceof ApiError && register.error.code === 'EMAIL_ALREADY_REGISTERED';
  const isPasswordShort = password.length > 0 && [...password.normalize('NFC')].length < PASSWORD_MINIMUM_CHARACTERS;
  const canSubmit = Boolean(fullName.trim() && email.trim() && mobileNumber.trim() && password && humanCheckToken) && !isPasswordShort;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canSubmit) register.mutate();
  };

  return (
    <form onSubmit={submit} noValidate>
      <SignUpLayout
        step="account"
        heading="Register your station"
        intro="About 5 minutes. We save as you go, so you can stop and come back."
        footer={
          <Button type="submit" disabled={!canSubmit} isBusy={register.isPending} busyLabel="Creating your account…" className="w-full min-h-13">
            Continue
          </Button>
        }
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <TextField label="Your full name" autoComplete="name" required value={fullName} onChange={(event) => setFullName(event.target.value)} error={fieldErrors.fullName} />
          <TextField
            label="Work email"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@yourstation.co.zm"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            error={isEmailTaken ? null : fieldErrors.email}
          />
          <div className="flex flex-col gap-1.5">
            <label htmlFor="sign-up-mobile-number" className="text-label">
              Mobile number
            </label>
            <div className="flex">
              <span aria-hidden="true" className="inline-flex min-h-12 items-center rounded-l-md border border-r-0 border-line bg-ground px-3 text-body">
                +260
              </span>
              <input
                id="sign-up-mobile-number"
                type="tel"
                autoComplete="tel-national"
                inputMode="tel"
                placeholder="97 123 4567"
                required
                aria-describedby="sign-up-mobile-number-hint"
                aria-invalid={fieldErrors.mobileNumber ? true : undefined}
                value={mobileNumber}
                onChange={(event) => setMobileNumber(event.target.value)}
                className="min-h-12 min-w-0 flex-1 rounded-r-md border border-line bg-surface px-3 text-[16px]"
              />
            </div>
            <span id="sign-up-mobile-number-hint" className="text-caption text-muted">
              We'll text a 6-digit code to this number.
            </span>
            {fieldErrors.mobileNumber ? (
              <span role="alert" className="text-caption font-bold text-danger">
                {fieldErrors.mobileNumber}
              </span>
            ) : null}
          </div>
          <TextField
            label="Password"
            type="password"
            autoComplete="new-password"
            required
            hint="At least 15 characters."
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onBlur={() => setIsPasswordLeft(true)}
            // Too short is said once the field is left, not at every key while it is typed.
            error={isPasswordShort ? (isPasswordLeft ? fieldReasonWords('too_short') : null) : fieldErrors.password}
          />
        </div>
        <HumanCheckWidget onToken={setHumanCheckToken} />
        {isEmailTaken ? (
          <div role="alert" className="flex flex-col gap-1 rounded-md border border-danger bg-danger-soft px-4 py-3 text-danger">
            <span className="text-body">This email already has an account.</span>
            <Link to="/sign-in" className="inline-flex min-h-11 items-center self-start text-label underline underline-offset-4">
              Sign in instead
            </Link>
          </div>
        ) : register.isError && Object.keys(fieldErrors).length === 0 ? (
          <ErrorNotice error={register.error} />
        ) : null}
      </SignUpLayout>
    </form>
  );
}
