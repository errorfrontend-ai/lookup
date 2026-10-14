import { DEFAULT_STATION_TIME_ZONE, type SaveStationApplicationDetailsInput, type StationApplication, ZAMBIAN_PROVINCES } from '@lookup/contracts';
import { type FormEvent, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { portalApi } from '../../app/portal-api';
import { Button } from '../../components/button';
import { ErrorNotice } from '../../components/error-notice';
import { SelectField } from '../../components/select-field';
import { TextField } from '../../components/text-field';
import { parseFrequencyLabel } from '../stations/parse-frequency-label';
import { FileUploadField } from './file-upload-field';
import { fieldErrorsFrom } from './sign-up-page';
import { SignUpLayout } from './sign-up-layout';
import { useApplicationChange, useStationApplication, useStationFileUpload } from './use-station-application';

/** "98.1fm" or "98.1 fm" is saved as "98.1 FM"; anything else as typed. */
export function tidyFrequencyLabel(typed: string): string {
  const parsed = parseFrequencyLabel(typed);
  return parsed ? `${parsed.numberText} ${parsed.band}` : typed.trim();
}

/** The time zones the browser knows, with the station's and Lusaka's always there. */
export function timeZoneChoices(current: string): string[] {
  const known = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return [...new Set([DEFAULT_STATION_TIME_ZONE, current, ...known])].sort();
}

/**
 * Step 3, "About your station" (P5A design §4.2; P5A-STATION-DETAILS-01..09): name, frequency (tidied), province,
 * town and an optional logo, then, folded away, the time zone, coverage and a stream link.
 */
export function DetailsStep() {
  const { stationId = '' } = useParams();
  const application = useStationApplication(stationId);
  if (application.isPending) return <p className="p-6 text-body text-muted">Loading your application…</p>;
  if (application.isError) return <div className="p-6"><ErrorNotice error={application.error} title="We couldn't load your application" /></div>;
  return <DetailsForm stationId={stationId} saved={application.data} />;
}

function DetailsForm({ stationId, saved }: { stationId: string; saved: StationApplication }) {
  const navigate = useNavigate();
  const [name, setName] = useState(saved.details.name ?? '');
  const [frequencyLabel, setFrequencyLabel] = useState(saved.details.frequencyLabel ?? '');
  const [province, setProvince] = useState(saved.details.province ?? '');
  const [city, setCity] = useState(saved.details.city ?? '');
  const [timeZone, setTimeZone] = useState(saved.details.timeZone);
  const [coverageNote, setCoverageNote] = useState(saved.details.coverageNote ?? '');
  const [streamAddress, setStreamAddress] = useState(saved.details.streamAddress ?? '');
  const logo = useStationFileUpload(stationId, 'logo');
  const save = useApplicationChange(stationId, (input: SaveStationApplicationDetailsInput) =>
    portalApi.put<StationApplication>(`/stations/${stationId}/application/details`, input),
  );
  const fieldErrors = fieldErrorsFrom(save.error);
  const canSave = Boolean(name.trim() && frequencyLabel.trim() && province && city.trim());

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    save.mutate(
      {
        name: name.trim(),
        frequencyLabel: tidyFrequencyLabel(frequencyLabel),
        province: province as SaveStationApplicationDetailsInput['province'],
        city: city.trim(),
        timeZone,
        coverageNote: coverageNote.trim() || null,
        streamAddress: streamAddress.trim() || null,
      },
      { onSuccess: () => void navigate(`/stations/${stationId}/application/licence`) },
    );
  };

  return (
    <form onSubmit={submit} noValidate>
      <SignUpLayout
        step="details"
        heading="About your station"
        onBack={() => void navigate(`/stations/${stationId}/application/verify`)}
        footer={
          <Button type="submit" className="w-full min-h-13" disabled={!canSave} isBusy={save.isPending} busyLabel="Saving…">
            Continue
          </Button>
        }
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <TextField label="Station name" required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} error={fieldErrors.name} />
          <TextField
            label="Frequency"
            required
            maxLength={32}
            hint="e.g. 98.1 FM"
            value={frequencyLabel}
            onChange={(event) => setFrequencyLabel(event.target.value)}
            onBlur={() => setFrequencyLabel((typed) => tidyFrequencyLabel(typed))}
            error={fieldErrors.frequencyLabel}
          />
          <SelectField label="Province" required value={province} onChange={(event) => setProvince(event.target.value)} error={fieldErrors.province}>
            <option value="">Choose province</option>
            {ZAMBIAN_PROVINCES.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </SelectField>
          <TextField label="City or town" required maxLength={80} value={city} onChange={(event) => setCity(event.target.value)} error={fieldErrors.city} />
        </div>
        <FileUploadField
          label="Add logo · PNG or JPG"
          hint="Optional. Square works best; at least 64 × 64 pixels, up to 2 MB."
          accept="image/png,image/jpeg"
          savedFileName={saved.details.logoAddress ? 'Your logo' : null}
          state={logo.state}
          onChoose={(file) => void logo.upload(file)}
        />
        {saved.details.logoAddress ? <img src={saved.details.logoAddress} alt="Your station's logo" width={96} height={96} className="size-24 rounded-md border border-line object-contain" /> : null}
        <details className="rounded-md border border-line p-4">
          <summary className="cursor-pointer text-label">More details (optional) — time zone, coverage, stream link</summary>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <SelectField label="Time zone" value={timeZone} onChange={(event) => setTimeZone(event.target.value)} error={fieldErrors.timeZone}>
              {timeZoneChoices(timeZone).map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </SelectField>
            <TextField label="Coverage" maxLength={300} hint="Where listeners can hear you, in a few words." value={coverageNote} onChange={(event) => setCoverageNote(event.target.value)} error={fieldErrors.coverageNote} />
            <TextField label="Stream link (https)" type="url" inputMode="url" maxLength={500} value={streamAddress} onChange={(event) => setStreamAddress(event.target.value)} error={fieldErrors.streamAddress} />
          </div>
        </details>
        {save.isError && Object.keys(fieldErrors).length === 0 ? <ErrorNotice error={save.error} /> : null}
      </SignUpLayout>
    </form>
  );
}
