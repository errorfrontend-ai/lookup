import { Link } from 'react-router';
import { useStationOverview } from '../features/stations/use-station-overview';

/**
 * In the sidebar, right under the station's dial: whether any of its ads are on air this minute. Live
 * ads link to the "Live now" tab. Only an approved station has ads, so only an approved station shows this.
 */
export function OnAirIndicator({ stationId }: { stationId: string }) {
  const overview = useStationOverview(stationId, true);
  if (!overview.isSuccess) return null;
  const liveCount = overview.data.adCounts.live;

  if (liveCount === 0) {
    return <p className="px-1 text-caption text-muted">Nothing on air right now</p>;
  }
  return (
    <Link
      to={`/stations/${stationId}/ads?view=live`}
      className="flex min-h-11 items-center gap-2 rounded-md bg-accent-soft px-3 text-label text-accent no-underline hover:underline"
    >
      <span aria-hidden="true" className="size-2.5 animate-on-air rounded-full bg-accent motion-reduce:animate-none" />
      {liveCount === 1 ? 'On air now · 1 ad' : `On air now · ${liveCount} ads`}
    </Link>
  );
}
