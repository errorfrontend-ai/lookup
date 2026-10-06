export const PHONE_WIDTHS = [320, 411] as const;
export type PhoneWidth = (typeof PHONE_WIDTHS)[number];

/** Chooses which phone the preview is drawn for: the smallest listeners have, or a large one. */
export function PhoneWidthToggle({ value, onChange }: { value: PhoneWidth; onChange: (width: PhoneWidth) => void }) {
  return (
    <div role="group" aria-label="Preview width" className="flex overflow-hidden rounded-md border border-line">
      {PHONE_WIDTHS.map((width) => (
        <button
          key={width}
          type="button"
          aria-pressed={value === width}
          onClick={() => onChange(width)}
          className={`min-h-11 px-3 text-label ${value === width ? 'bg-ink text-surface' : 'bg-surface text-ink'}`}
        >
          {width === 320 ? 'Small phone · 320' : 'Large phone · 411'}
        </button>
      ))}
    </div>
  );
}
