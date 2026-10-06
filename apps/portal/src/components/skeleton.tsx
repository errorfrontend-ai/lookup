/** A grey placeholder while content loads. Hidden from screen readers; the page announces loading itself. */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded-md bg-ink/10 motion-reduce:animate-none ${className}`} />;
}

/** Placeholder rows for a list that is loading. */
export function SkeletonRows({ count = 5, rowClassName = 'h-16' }: { count?: number; rowClassName?: string }) {
  return (
    <div role="status" aria-busy="true" aria-label="Loading" className="flex flex-col gap-2">
      {Array.from({ length: count }, (_unused, index) => (
        <Skeleton key={index} className={`w-full ${rowClassName}`} />
      ))}
    </div>
  );
}
