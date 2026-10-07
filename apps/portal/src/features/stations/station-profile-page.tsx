import { MAXIMUM_CITY_LENGTH, type StationProfile, type UpdateStationProfileInput, ZAMBIAN_PROVINCES } from '@lookup/contracts';
import { type FormEvent, type ReactNode, useState } from 'react';
import { ApiError } from '../../api/api-client';
import { Badge } from '../../components/badge';
import { Button } from '../../components/button';
import { ErrorNotice } from '../../components/error-notice';
import { PageHeader } from '../../components/page-header';
import { SelectField } from '../../components/select-field';
import { Skeleton } from '../../components/skeleton';
import { TextField } from '../../components/text-field';
import { useToast } from '../../components/toast-region';
import { describeStationRole, describeStationStatus } from '../../plain-words/station-status-words';
import { canChangeStationProfile, useRequiredCurrentStation } from './use-current-station';
import { useStationProfile, useUpdateStationProfile } from './use-station-profile';
import { browserMaxLength } from '../../formatting/text-length';

function ProfileRow({ label, children, note }: { label: string; children: ReactNode; note?: string }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[11rem_1fr] sm:gap-4">
      <dt className="text-label text-muted">{label}</dt>
      <dd className="m-0 flex flex-col gap-1">
        <span className="text-body">{children}</span>
        {note ? <span className="text-caption text-muted">{note}</span> : null}
      </dd>
    </div>
  );
}

/** Where the station is: province and city. Owners and managers can change them; the rest is checked by Look Up. */
function WhereYouAreForm({ stationId, profile, onDone }: { stationId: string; profile: StationProfile; onDone: () => void }) {
  const [province, setProvince] = useState(profile.province ?? '');
  const [city, setCity] = useState(profile.city ?? '');
  const update = useUpdateStationProfile(stationId);
  const showToast = useToast();
  const hasFieldProblem = update.error instanceof ApiError && update.error.code === 'VALIDATION_FAILED';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    update.mutate(
      { province: (province || null) as UpdateStationProfileInput['province'], city: city.trim() || null },
      {
        onSuccess: () => {
          showToast('Station details saved');
          onDone();
        },
      },
    );
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4 py-4">
      <SelectField label="Province" value={province} onChange={(event) => setProvince(event.target.value)}>
        <option value="">Not set</option>
        {ZAMBIAN_PROVINCES.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </SelectField>
      <TextField
        label="City or town"
        value={city}
        onChange={(event) => setCity(event.target.value)}
        maxLength={browserMaxLength(MAXIMUM_CITY_LENGTH)}
        counter={`${[...city].length} / ${MAXIMUM_CITY_LENGTH}`}
        error={hasFieldProblem ? `Enter a city or town of up to ${MAXIMUM_CITY_LENGTH} characters, or leave it empty.` : null}
        autoComplete="off"
      />
      {update.isError && !hasFieldProblem ? <ErrorNotice error={update.error} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" isBusy={update.isPending} busyLabel="Saving…">
          Save
        </Button>
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function StationProfilePage() {
  const station = useRequiredCurrentStation();
  const profile = useStationProfile(station.id);
  const [isEditing, setIsEditing] = useState(false);
  const canEdit = canChangeStationProfile(station);

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageHeader
        title="Station profile"
        description="How your station appears in Look Up."
        actions={
          canEdit && profile.isSuccess && !isEditing ? (
            <Button variant="secondary" onClick={() => setIsEditing(true)}>
              Edit where you are
            </Button>
          ) : undefined
        }
      />

      {profile.isPending ? <Skeleton className="h-72 w-full" /> : null}
      {profile.isError ? (
        <div className="flex flex-col items-start gap-3">
          <ErrorNotice error={profile.error} title="We couldn't load your station's details" />
          <Button variant="secondary" onClick={() => void profile.refetch()}>
            Try again
          </Button>
        </div>
      ) : null}
      {profile.isSuccess ? (
        <section aria-label="Station details" className="rounded-lg border border-line-soft bg-surface px-5 py-2">
          <dl className="m-0 divide-y divide-line-soft">
            <ProfileRow label="Name">{profile.data.name}</ProfileRow>
            <ProfileRow label="Frequency">{profile.data.frequencyLabel}</ProfileRow>
            {isEditing ? (
              <WhereYouAreForm stationId={station.id} profile={profile.data} onDone={() => setIsEditing(false)} />
            ) : (
              <>
                <ProfileRow label="Province">{profile.data.province ?? <span className="text-muted">Not set</span>}</ProfileRow>
                <ProfileRow label="City or town">{profile.data.city ?? <span className="text-muted">Not set</span>}</ProfileRow>
              </>
            )}
            <ProfileRow label="Time zone" note="Every date and time in the portal, and every ad schedule, is in this time zone.">
              {profile.data.timeZone}
            </ProfileRow>
            <ProfileRow label="Status" note={describeStationStatus(profile.data.status).banner ?? 'Your station is approved and can add ads.'}>
              <Badge tone={describeStationStatus(profile.data.status).tone}>{describeStationStatus(profile.data.status).label}</Badge>
            </ProfileRow>
            <ProfileRow label="Your role">{describeStationRole(profile.data.yourRole)}</ProfileRow>
          </dl>
        </section>
      ) : null}

      <p className="text-caption text-muted">
        Changes to your station's name, frequency or licence are checked by Look Up before they go live, so they can't be made here.
      </p>
    </div>
  );
}
