import { NavLink, useNavigate } from 'react-router';
import { FrequencyDial } from '../components/frequency-dial';
import { Icon, type IconName } from '../components/icons';
import { describeStationRole } from '../plain-words/station-status-words';
import { useSignOut } from '../features/session/use-sign-out';
import { useSignedInUser } from '../features/session/use-signed-in-user';
import { stationHomePath } from '../features/stations/station-home-path';
import type { MemberStation } from '../features/stations/use-current-station';

interface NavigationItem {
  path: string;
  label: string;
  icon: IconName;
  /** Needs an approved station: hidden while the station is under review or suspended. */
  needsActiveStation: boolean;
}

const NAVIGATION_ITEMS: NavigationItem[] = [
  { path: 'ads', label: 'Ads', icon: 'ads', needsActiveStation: true },
  { path: 'clients', label: 'Clients', icon: 'clients', needsActiveStation: true },
  { path: 'profile', label: 'Station profile', icon: 'profile', needsActiveStation: false },
];

const linkClass = ({ isActive }: { isActive: boolean }) =>
  [
    'flex min-h-11 items-center gap-3 rounded-md px-3 text-label no-underline',
    isActive ? 'bg-accent-soft font-bold text-accent shadow-[inset_3px_0_0_var(--color-accent)]' : 'text-ink hover:bg-ground',
  ].join(' ');

/**
 * The station's dial, the places to go, and who is signed in. The same content fills the sidebar on
 * wide screens and the drawer on phones.
 */
export function PortalNavigation({ station }: { station: MemberStation }) {
  const signedInUser = useSignedInUser();
  const signOut = useSignOut();
  const navigate = useNavigate();
  const stations = signedInUser.data?.stations ?? [];
  const stationPath = `/stations/${station.id}`;
  const visibleItems = NAVIGATION_ITEMS.filter((item) => !item.needsActiveStation || station.status === 'ACTIVE');

  return (
    <div className="flex flex-1 flex-col gap-5 px-4 pb-4 lg:pt-6">
      <span className="hidden items-center gap-2 font-display text-title lg:flex">
        <Icon name="radio" size={24} className="text-accent" />
        Look Up
      </span>

      <FrequencyDial stationName={station.name} frequencyLabel={station.frequencyLabel} />

      {stations.length > 1 ? (
        <label className="flex flex-col gap-1.5">
          <span className="text-caption text-muted">Station</span>
          <select
            value={station.id}
            onChange={(event) => {
              const chosen = stations.find((memberStation) => memberStation.id === event.target.value);
              if (chosen) void navigate(stationHomePath(chosen));
            }}
            className="min-h-11 rounded-md border border-line bg-surface px-2 text-body"
          >
            {stations.map((memberStation) => (
              <option key={memberStation.id} value={memberStation.id}>
                {memberStation.name} · {memberStation.frequencyLabel}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <nav aria-label="Main">
        <ul className="flex flex-col gap-1">
          {visibleItems.map((item) => (
            <li key={item.path}>
              <NavLink to={`${stationPath}/${item.path}`} className={linkClass}>
                <Icon name={item.icon} />
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <div className="mt-auto flex flex-col gap-1 border-t border-line-soft pt-4">
        {signedInUser.data ? (
          <div className="flex flex-col px-3">
            <span className="truncate text-label">{signedInUser.data.user.fullName}</span>
            <span className="text-caption text-muted">{describeStationRole(station.role)}</span>
          </div>
        ) : null}
        <NavLink to={`${stationPath}/account`} className={linkClass}>
          <Icon name="account" />
          Your account
        </NavLink>
        <button type="button" onClick={() => void signOut()} className="flex min-h-11 items-center gap-3 rounded-md px-3 text-left text-label text-ink hover:bg-ground">
          <Icon name="signOut" />
          Sign out
        </button>
      </div>
    </div>
  );
}
