import { LISTENER_FIGURES_RANGES, LISTENER_MIX_MINIMUM_GROUP_SIZE, type ListenerFiguresRange, type ListenerMix } from '@lookup/contracts';
import { useId, useState } from 'react';
import { Button } from '../../components/button';
import { ErrorNotice } from '../../components/error-notice';
import { FigureTile } from '../../components/figure-tile';
import { Skeleton } from '../../components/skeleton';
import { describeAgeBandGroup, describeGenderGroup } from '../../plain-words/listener-mix-words';
import { useListenerMix } from '../stations/use-listener-mix';

const RANGE_CHOICES: Record<ListenerFiguresRange, string> = { today: 'Today', last7Days: 'Last 7 days', last30Days: 'Last 30 days' };

interface Breakdown {
  title: string;
  rows: Array<{ label: string; listeners: number }>;
}

/** One breakdown as bars: each row names its group and its number in words a screen reader reads; the bar is decoration. */
function BreakdownBars({ breakdown }: { breakdown: Breakdown }) {
  const highest = Math.max(1, ...breakdown.rows.map((row) => row.listeners));
  return (
    <ul aria-label={breakdown.title} className="flex flex-col gap-2">
      {breakdown.rows.map((row) => (
        <li key={row.label} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_3rem] items-center gap-2 text-label">
          <span className="truncate">{row.label}</span>
          <span aria-hidden="true" className="h-3 rounded-sm bg-ground">
            <span className="block h-3 rounded-sm bg-accent" style={{ width: `${(row.listeners / highest) * 100}%` }} />
          </span>
          <span className="text-right tabular-nums">{row.listeners}</span>
        </li>
      ))}
    </ul>
  );
}

function BreakdownTable({ breakdown }: { breakdown: Breakdown }) {
  return (
    <table className="w-full text-left text-label">
      <caption className="sr-only">{`Listeners ${breakdown.title.toLowerCase()}`}</caption>
      <thead>
        <tr className="text-muted">
          <th scope="col" className="py-1">
            Group
          </th>
          <th scope="col" className="py-1 text-right">
            Listeners
          </th>
        </tr>
      </thead>
      <tbody>
        {breakdown.rows.map((row) => (
          <tr key={row.label} className="border-t border-line-soft">
            <th scope="row" className="py-1 font-normal">
              {row.label}
            </th>
            <td className="py-1 text-right tabular-nums">{row.listeners}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The two breakdowns side by side (one column on a phone), with one Chart/Table switch for both. */
function Breakdowns({ mix }: { mix: ListenerMix }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const breakdowns: Breakdown[] = [
    { title: 'By gender', rows: (mix.genders ?? []).map((group) => ({ label: describeGenderGroup(group.group), listeners: group.listeners })) },
    { title: 'By age', rows: (mix.ageBands ?? []).map((group) => ({ label: describeAgeBandGroup(group.group), listeners: group.listeners })) },
  ];
  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label="Show who is listening as" className="flex self-start rounded-md border border-line">
        {(['chart', 'table'] as const).map((choice) => (
          <button
            key={choice}
            type="button"
            aria-pressed={view === choice}
            onClick={() => setView(choice)}
            className={`min-h-11 px-4 text-label first:rounded-l-md last:rounded-r-md ${view === choice ? 'bg-ink text-surface' : 'bg-surface text-ink hover:bg-ground'}`}
          >
            {choice === 'chart' ? 'Chart' : 'Table'}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {breakdowns.map((breakdown) => (
          <section key={breakdown.title} aria-label={breakdown.title} className="flex flex-col gap-3 rounded-lg border border-line-soft bg-surface p-5">
            <h3 className="text-heading">{breakdown.title}</h3>
            {view === 'chart' ? <BreakdownBars breakdown={breakdown} /> : <BreakdownTable breakdown={breakdown} />}
          </section>
        ))}
      </div>
    </div>
  );
}

/**
 * Who is listening (ADR-005, docs/design/listener-accounts.md §7; LA-STATS-07): different listeners who identified the
 * station's ads, or one ad, and of those who gave their gender and age, the groups of at least 10. On Overview it follows
 * the page's dates; on an ad it has its own date choice.
 */
export function ListenerMixSection({
  stationId,
  adId,
  range,
  onRangeChange,
}: {
  stationId: string;
  adId?: string;
  range: ListenerFiguresRange;
  /** Given, the section offers its own date choice; left out, it follows the page's. */
  onRangeChange?: (range: ListenerFiguresRange) => void;
}) {
  const headingId = useId();
  const mix = useListenerMix(stationId, range, adId);
  const whose = adId ? 'this ad' : 'your ads';
  // The dates the numbers on screen are for: while new dates load, the last numbers stay, under their own dates.
  const shownRange = mix.data?.range ?? range;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col">
          <h2 id={headingId} className="text-heading">
            Who is listening
          </h2>
          <span className="text-caption text-muted">{`${RANGE_CHOICES[shownRange]} · people who identified ${whose} in the Look Up app`}</span>
        </div>
        {onRangeChange ? (
          <label className="flex flex-col">
            <span className="sr-only">Dates for who is listening</span>
            <select
              value={range}
              onChange={(event) => onRangeChange(event.target.value as ListenerFiguresRange)}
              className="min-h-11 rounded-md border border-line bg-surface px-3 text-label text-ink"
            >
              {LISTENER_FIGURES_RANGES.map((choice) => (
                <option key={choice} value={choice}>
                  {RANGE_CHOICES[choice]}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {mix.isPending ? <Skeleton className="h-28 w-full" /> : null}
      {mix.isError ? (
        <div className="flex flex-col items-start gap-3">
          <ErrorNotice error={mix.error} title="We couldn't load who is listening" />
          <Button variant="secondary" onClick={() => void mix.refetch()}>
            Try again
          </Button>
        </div>
      ) : null}
      {mix.data ? (
        <>
          <dl aria-label="Listeners" className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <FigureTile title="Listeners" value={String(mix.data.listeners)} note={`Different people who identified ${whose}`} />
            <FigureTile title="With an account" value={String(mix.data.knownListeners)} note="They told us their gender and age" />
            <FigureTile title="People we don't know yet" value={String(mix.data.notKnownYetListeners)} note="No account yet, or signed out" />
          </dl>
          {mix.data.listeners === 0 ? (
            <p className="text-body text-muted">{`No listeners in these dates yet. They appear here once people identify ${whose} in the Look Up app.`}</p>
          ) : mix.data.genders === null || mix.data.ageBands === null ? (
            <p className="text-body text-muted">
              {`Not enough listeners yet to show groups. Groups appear once at least ${LISTENER_MIX_MINIMUM_GROUP_SIZE} listeners with an account have identified ${whose}.`}
            </p>
          ) : (
            <Breakdowns mix={mix.data} />
          )}
          <p className="text-caption text-muted">
            {`To protect listeners, you only ever see groups: a group with fewer than ${LISTENER_MIX_MINIMUM_GROUP_SIZE} people is counted under "Other groups", and nobody's name or email is shown.`}
          </p>
        </>
      ) : null}
    </section>
  );
}
