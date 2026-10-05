import { useRequiredCurrentStation } from '../stations/use-current-station';

/** The station's ads. The full list (table on wide screens, cards on phones) arrives in the next increment. */
export function AdsListPage() {
  const station = useRequiredCurrentStation();
  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-display">Ads</h1>
      <p className="text-body text-muted">{station.name}</p>
    </div>
  );
}
