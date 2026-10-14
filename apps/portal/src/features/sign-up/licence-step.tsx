import { APPLICATION_REVIEW_TIME_TEXT, type StationApplication } from '@lookup/contracts';
import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { portalApi } from '../../app/portal-api';
import { ApiError } from '../../api/api-client';
import { Button } from '../../components/button';
import { ErrorNotice } from '../../components/error-notice';
import { TextField } from '../../components/text-field';
import { MISSING_PART_WORDS } from '../../plain-words/sign-up-words';
import { FileUploadField } from './file-upload-field';
import { fieldErrorsFrom } from './sign-up-page';
import { SignUpLayout } from './sign-up-layout';
import { useApplicationChange, useStationApplication, useStationFileUpload } from './use-station-application';

/**
 * Step 4, "Your broadcasting licence" (P5A design §4.2; P5A-LICENCE-01..07): the number, the document (PDF or a
 * photo, up to 5 MB, seen only by the review team), the confirmation, then "Submit for review" — or, after a
 * rejection, "Submit again"; while under review, changes are saved without submitting again.
 */
export function LicenceStep() {
  const { stationId = '' } = useParams();
  const application = useStationApplication(stationId);
  if (application.isPending) return <p className="p-6 text-body text-muted">Loading your application…</p>;
  if (application.isError) return <div className="p-6"><ErrorNotice error={application.error} title="We couldn't load your application" /></div>;
  return <LicenceForm stationId={stationId} saved={application.data} />;
}

function LicenceForm({ stationId, saved }: { stationId: string; saved: StationApplication }) {
  const navigate = useNavigate();
  const [licenceNumber, setLicenceNumber] = useState(saved.licence.licenceNumber ?? '');
  const [isConfirmed, setIsConfirmed] = useState(false);
  const document = useStationFileUpload(stationId, 'licence-document');
  const saveNumber = useApplicationChange(stationId, (typed: string) =>
    portalApi.put<StationApplication>(`/stations/${stationId}/application/licence`, { licenceNumber: typed }),
  );
  const submit = useApplicationChange(stationId, () => portalApi.post<StationApplication>(`/stations/${stationId}/application/submission`, { isLicenceConfirmed: true }));
  const sendLink = useMutation({ mutationFn: () => portalApi.post<void>(`/stations/${stationId}/application/email-verification-links`) });
  const isUnderReview = saved.status === 'PENDING_REVIEW';
  const isResubmission = saved.status === 'REJECTED';
  const hasDocument = Boolean(saved.licence.document);
  const canSubmit = Boolean(licenceNumber.trim()) && hasDocument && (isUnderReview || isConfirmed);
  const fieldErrors = fieldErrorsFrom(saveNumber.error);
  const missing = submit.error instanceof ApiError && submit.error.code === 'APPLICATION_INCOMPLETE' ? submit.error.fields.map((field) => field.code) : [];

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    if (licenceNumber.trim() !== saved.licence.licenceNumber) {
      const isSaved = await saveNumber.mutateAsync(licenceNumber.trim()).then(
        () => true,
        () => false,
      );
      if (!isSaved) return;
    }
    if (isUnderReview) return void navigate(`/stations/${stationId}/application`);
    submit.mutate(undefined, { onSuccess: () => void navigate(`/stations/${stationId}/application`) });
  };

  return (
    <form onSubmit={(event) => void send(event)} noValidate>
      <SignUpLayout
        step="licence"
        heading="Your broadcasting licence"
        intro="We check every station before it goes live. It stops fake stations putting scam buttons on real ads."
        onBack={() => void navigate(`/stations/${stationId}/application/details`)}
        footer={
          <Button type="submit" className="w-full min-h-13" disabled={!canSubmit} isBusy={submit.isPending || saveNumber.isPending} busyLabel="Sending…">
            {isUnderReview ? 'Save changes' : isResubmission ? 'Submit again' : 'Submit for review'}
          </Button>
        }
      >
        <TextField label="Licence number" required maxLength={60} value={licenceNumber} onChange={(event) => setLicenceNumber(event.target.value)} error={fieldErrors.licenceNumber} />
        <FileUploadField
          label="Licence document"
          hint="PDF or a clear photo, up to 5 MB. Only our review team can see it."
          accept="application/pdf,image/jpeg"
          savedFileName={saved.licence.document?.fileName ?? null}
          state={document.state}
          onChoose={(file) => void document.upload(file)}
        />
        {isUnderReview ? null : (
          <label className="flex items-start gap-3 text-body">
            <input type="checkbox" checked={isConfirmed} onChange={(event) => setIsConfirmed(event.target.checked)} className="mt-1 size-5" />
            I confirm this station holds a valid broadcasting licence in Zambia.
          </label>
        )}
        <p className="text-body text-muted">
          What happens next: we review your application within {APPLICATION_REVIEW_TIME_TEXT} and let you know by SMS and email.
        </p>
        {saved.verification.isEmailVerified ? null : (
          <div className="flex flex-col items-start gap-2 rounded-md border border-warning bg-warning-soft px-4 py-3">
            <p className="text-body">Confirm your email before you submit: open the link we sent to {saved.account.email}.</p>
            <Button variant="quiet" onClick={() => sendLink.mutate()} isBusy={sendLink.isPending} busyLabel="Sending…">
              Send the link again
            </Button>
            {sendLink.isSuccess ? <p className="text-caption text-muted">Sent. It can take a minute to arrive.</p> : null}
          </div>
        )}
        {missing.length > 0 ? (
          <div role="alert" className="flex flex-col gap-2 rounded-md border border-danger bg-danger-soft px-4 py-3">
            <p className="text-label text-danger">Your application isn't finished yet. Still needed:</p>
            <ul className="flex list-disc flex-col gap-1 pl-5">
              {missing.map((part) => {
                const words = MISSING_PART_WORDS[part];
                return words ? (
                  <li key={part}>
                    <Link to={`/stations/${stationId}/application/${words.step}`} className="text-body underline underline-offset-4">
                      {words.words}
                    </Link>
                  </li>
                ) : null;
              })}
            </ul>
          </div>
        ) : submit.isError ? (
          <ErrorNotice error={submit.error} />
        ) : null}
        {saveNumber.isError && Object.keys(fieldErrors).length === 0 ? <ErrorNotice error={saveNumber.error} /> : null}
      </SignUpLayout>
    </form>
  );
}
