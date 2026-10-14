import type { StationApplication } from '@lookup/contracts';
import { type FormEvent, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { portalApi } from '../../app/portal-api';
import { ApiError } from '../../api/api-client';
import { Button } from '../../components/button';
import { ErrorNotice } from '../../components/error-notice';
import { TextField } from '../../components/text-field';
import { fieldErrorsFrom } from '../../plain-words/sign-up-words';
import { SignUpLayout } from './sign-up-layout';
import { useApplicationChange, useStationApplication } from './use-station-application';

/**
 * Step 1 changed later (Back from step 2, or Edit application; P5A design §3.3): name, email and mobile number. The
 * number is shown masked, so it is typed again only to change it. A new number gets a new code, a new email a new link.
 */
export function AccountStep() {
  const { stationId = '' } = useParams();
  const application = useStationApplication(stationId);
  if (application.isPending) return <p className="p-6 text-body text-muted">Loading your application…</p>;
  if (application.isError) return <div className="p-6"><ErrorNotice error={application.error} title="We couldn't load your application" /></div>;
  return <AccountForm stationId={stationId} saved={application.data} />;
}

function AccountForm({ stationId, saved }: { stationId: string; saved: StationApplication }) {
  const navigate = useNavigate();
  const [fullName, setFullName] = useState(saved.account.fullName);
  const [email, setEmail] = useState(saved.account.email);
  const [mobileNumber, setMobileNumber] = useState('');
  const change = useApplicationChange(stationId, () =>
    portalApi.put<StationApplication>(`/stations/${stationId}/application/account`, { fullName, email, mobileNumber }),
  );
  const fieldErrors = fieldErrorsFrom(change.error);
  const isEmailTaken = change.error instanceof ApiError && change.error.code === 'EMAIL_ALREADY_REGISTERED';
  const goOn = () => void navigate(`/stations/${stationId}/application/verify`);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!mobileNumber.trim() && fullName === saved.account.fullName && email === saved.account.email) return goOn();
    if (!mobileNumber.trim()) return;
    change.mutate(undefined, { onSuccess: goOn });
  };

  return (
    <form onSubmit={submit} noValidate>
      <SignUpLayout
        step="account"
        heading="Your account"
        intro="Change your details here. A new number gets a new code, a new email a new link."
        onBack={() => void navigate(`/stations/${stationId}/application`)}
        footer={
          <Button type="submit" className="w-full min-h-13" isBusy={change.isPending} busyLabel="Saving…">
            Continue
          </Button>
        }
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <TextField label="Your full name" autoComplete="name" value={fullName} onChange={(event) => setFullName(event.target.value)} error={fieldErrors.fullName} />
          <TextField label="Work email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} error={isEmailTaken ? 'This email already has an account.' : fieldErrors.email} />
          <TextField
            label="Mobile number"
            type="tel"
            autoComplete="tel-national"
            placeholder="97 123 4567"
            hint={`Now ${saved.account.mobileNumber ?? 'not given'}. Type the number again to save any change here.`}
            value={mobileNumber}
            onChange={(event) => setMobileNumber(event.target.value)}
            error={fieldErrors.mobileNumber}
          />
        </div>
        {change.isError && !isEmailTaken && Object.keys(fieldErrors).length === 0 ? <ErrorNotice error={change.error} /> : null}
      </SignUpLayout>
    </form>
  );
}
