/** A bar showing how far something has got, announced to screen readers as a percentage. */
export function ProgressBar({ percent, label }: { percent: number; label: string }) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={clamped} className="h-2 w-full overflow-hidden rounded-pill bg-line-soft">
      <div style={{ width: `${clamped}%` }} className="h-full rounded-pill bg-accent transition-[width] duration-200 motion-reduce:transition-none" />
    </div>
  );
}
