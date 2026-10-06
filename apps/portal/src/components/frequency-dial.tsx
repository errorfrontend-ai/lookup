import { FM_BAND_END, FM_BAND_START, parseFrequencyLabel } from '../features/stations/parse-frequency-label';

const SCALE_WIDTH = 200;
const SCALE_PADDING = 4;
const WHOLE_MEGAHERTZ_TICKS = Array.from({ length: 21 }, (_unused, index) => 88 + index);

function positionOnScale(megahertz: number): number {
  return SCALE_PADDING + ((megahertz - FM_BAND_START) / (FM_BAND_END - FM_BAND_START)) * (SCALE_WIDTH - SCALE_PADDING * 2);
}

/** A tuning scale from 88 to 108 MHz with a needle at the station's frequency. Decoration only. */
function FmScale({ megahertz }: { megahertz: number }) {
  return (
    <svg viewBox={`0 0 ${SCALE_WIDTH} 22`} className="h-5 w-full" aria-hidden="true" focusable="false">
      <g stroke="currentColor" strokeWidth="1" className="text-surface/50">
        {WHOLE_MEGAHERTZ_TICKS.map((tick) => (
          <line key={tick} x1={positionOnScale(tick)} x2={positionOnScale(tick)} y1={tick % 5 === 0 ? 8 : 12} y2="18" />
        ))}
      </g>
      <line x1={positionOnScale(megahertz)} x2={positionOnScale(megahertz)} y1="1" y2="20" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-accent" />
    </svg>
  );
}

/**
 * The station's name and frequency drawn like a radio's tuning dial: the number large, and for FM a
 * scale with a needle on it. The words are the content; the scale is decoration.
 */
export function FrequencyDial({ stationName, frequencyLabel }: { stationName: string; frequencyLabel: string }) {
  const frequency = parseFrequencyLabel(frequencyLabel);
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-ink p-4 text-surface">
      <span className="truncate text-caption text-surface/70">{stationName}</span>
      {frequency ? (
        <span className="flex items-baseline gap-1.5 font-display">
          <span className="text-[2rem] font-bold leading-none tabular-nums">{frequency.numberText}</span>
          <span className="text-label">{frequency.band}</span>
        </span>
      ) : (
        <span className="font-display text-title leading-none">{frequencyLabel}</span>
      )}
      {frequency?.band === 'FM' ? <FmScale megahertz={frequency.value} /> : null}
    </div>
  );
}
