import type { ReactNode } from 'react';
import { Badge } from '../../components/badge';
import { Button } from '../../components/button';
import { ErrorNotice } from '../../components/error-notice';
import { PageHeader } from '../../components/page-header';
import { Skeleton } from '../../components/skeleton';
import { describeStationRole, describeStationStatus } from '../../plain-words/station-status-words';
import { useRequiredCurrentStation } from './use-current-station';
import { useStationProfile } from './use-station-profile';

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

/** The station's own details. Province and city become editable in a later step; the rest is checked by Look Up. */
export function StationProfilePage() {
  const station = useRequiredCurrentStation();
  const profile = useStationProfile(station.id);

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageHeader title="Station profile" description="How your station appears in Look Up." />

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
            <ProfileRow label="Province">{profile.data.province ?? <span className="text-muted">Not set</span>}</ProfileRow>
            <ProfileRow label="City or town">{profile.data.city ?? <span className="text-muted">Not set</span>}</ProfileRow>
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
