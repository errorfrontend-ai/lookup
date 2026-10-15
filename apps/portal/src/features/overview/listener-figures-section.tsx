import { LISTENER_FIGURES_RANGES, type ListenerFigures, type ListenerFiguresRange, wholePercentOf } from '@lookup/contracts';
import { useState } from 'react';
import { Button } from '../../components/button';
import { ErrorNotice } from '../../components/error-notice';
import { FigureTile } from '../../components/figure-tile';
import { Skeleton } from '../../components/skeleton';
import { useListenerFigures } from '../stations/use-listener-figures';

const RANGE_CHOICES: Record<ListenerFiguresRange, string> = { today: 'Today', last7Days: 'Last 7 days', last30Days: 'Last 30 days' };
/** How a tile's title names the range: "Recognitions · 7 days". */
const RANGE_IN_TITLES: Record<ListenerFiguresRange, string> = { today: 'today', last7Days: '7 days', last30Days: '30 days' };
/** The hours the chart labels under its bars (P5B-OVERVIEW-13). */
const LABELLED_HOURS = [0, 6, 12, 18, 23];

export function isListenerFiguresRange(value: string | null): value is ListenerFiguresRange {
  return LISTENER_FIGURES_RANGES.some((range) => range === value);
}

const hourLabel = (hour: number) => `${String(hour).padStart(2, '0')}:00`;
const percentText = (percent: number | null) => (percent === null ? '—' : `${percent} %`);

function KeyNumbers({ figures }: { figures: ListenerFigures }) {
  const inRange = RANGE_IN_TITLES[figures.range];
  return (
    <dl aria-label="Key numbers" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <FigureTile title="Recognitions today" value={String(figures.recognitionsToday)} note="Listeners who identified one of your ads" />
      <FigureTile title={`Recognitions · ${inRange}`} value={String(figures.recognitions)} note="Includes clips sent later from no-signal areas" />
      <FigureTile title={`Button taps · ${inRange}`} value={String(figures.buttonTaps)} note="Calls, chats, directions and links" />
      <FigureTile title={`Tap rate · ${inRange}`} value={percentText(wholePercentOf(figures.buttonTaps, figures.recognitions))} note="Taps per recognition" />
      <FigureTile
        title={`Sent later · ${inRange}`}
        value={percentText(wholePercentOf(figures.recognitionsSentLater, figures.recognitions))}
        note="Heard where there was no signal, sent once there was"
      />
    </dl>
  );
}

/** Recognitions by the hour they were heard, station time: bars for the eye, the same numbers as a table for everyone. */
function RecognitionsByHour({ figures }: { figures: ListenerFigures }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const highest = Math.max(1, ...figures.recognitionsByHour);
  return (
    <section aria-labelledby="recognitions-by-hour" className="flex flex-col gap-3 rounded-lg border border-line-soft bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col">
          <h3 id="recognitions-by-hour" className="text-heading">
            Recognitions by hour
          </h3>
          <span className="text-caption text-muted">When listeners heard your ads, in station time</span>
        </div>
        <div role="group" aria-label="View" className="flex rounded-md border border-line">
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
      </div>
      {view === 'chart' ? (
        <>
          <div aria-hidden="true" className="flex w-full flex-col gap-1">
            <div className="grid h-40 grid-cols-24 items-end gap-0.5">
              {figures.recognitionsByHour.map((count, hour) => (
                <div key={hour} data-hour={hour} className="rounded-t-sm bg-accent" style={{ height: `${(count / highest) * 100}%`, minHeight: count > 0 ? 2 : 0 }} />
              ))}
            </div>
            <div className="grid grid-cols-24 text-caption text-muted tabular-nums">
              {figures.recognitionsByHour.map((_count, hour) => (
                // The last label sits at the right edge, so it never reaches past the page on a phone.
                <span key={hour} className={`flex overflow-visible whitespace-nowrap ${hour === 23 ? 'justify-end' : ''}`}>
                  {LABELLED_HOURS.includes(hour) ? hourLabel(hour) : ''}
                </span>
              ))}
            </div>
          </div>
          <p className="sr-only">The chart's numbers are in its table: choose Table.</p>
        </>
      ) : (
        <table className="w-full text-left text-label">
          <caption className="sr-only">Recognitions by hour, station time</caption>
          <thead>
            <tr className="text-muted">
              <th scope="col" className="py-1">Hour</th>
              <th scope="col" className="py-1 text-right">Recognitions</th>
            </tr>
          </thead>
          <tbody>
            {figures.recognitionsByHour.map((count, hour) => (
              <tr key={hour} className="border-t border-line-soft">
                <th scope="row" className="py-1 font-normal tabular-nums">{`${hourLabel(hour)}–${hourLabel((hour + 1) % 24)}`}</th>
                <td className="py-1 text-right tabular-nums">{count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** How listeners responded to the station's ads (P5B-OVERVIEW-02 to -16): the key numbers and when they listened. */
export function ListenerFiguresSection({
  stationId,
  range,
  onRangeChange,
}: {
  stationId: string;
  range: ListenerFiguresRange;
  onRangeChange: (range: ListenerFiguresRange) => void;
}) {
  const figures = useListenerFigures(stationId, range);
  return (
    <section aria-labelledby="listener-figures" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="listener-figures" className="text-heading">
          How listeners responded
        </h2>
        <label className="flex flex-col">
          <span className="sr-only">Date range</span>
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
      </div>
      {figures.isPending ? <Skeleton className="h-28 w-full" /> : null}
      {figures.isError ? (
        <div className="flex flex-col items-start gap-3">
          <ErrorNotice error={figures.error} title="We couldn't load how listeners responded" />
          <Button variant="secondary" onClick={() => void figures.refetch()}>
            Try again
          </Button>
        </div>
      ) : null}
      {figures.data ? (
        <>
          <KeyNumbers figures={figures.data} />
          {figures.data.recognitions === 0 ? (
            <p className="text-body text-muted">Numbers appear here as listeners identify your ads in the Look Up app.</p>
          ) : null}
          <RecognitionsByHour figures={figures.data} />
        </>
      ) : null}
    </section>
  );
}
