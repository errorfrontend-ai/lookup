/** One key number: its title, the number in tabular figures, and a line saying what it counts. */
export function FigureTile({ title, value, note, className = '' }: { title: string; value: string; note: string; className?: string }) {
  return (
    <div className={`flex flex-col gap-1 rounded-lg border border-line-soft bg-surface p-4 ${className}`}>
      <dt className="text-label text-muted">{title}</dt>
      <dd className="font-display text-display tabular-nums">{value}</dd>
      <dd className="text-caption text-muted">{note}</dd>
    </div>
  );
}
