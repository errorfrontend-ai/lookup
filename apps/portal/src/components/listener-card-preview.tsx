import { type ReadAction, readActionCard } from '@lookup/contracts';
import { Icon, type IconName } from './icons';

const ACTION_ICONS: Record<ReadAction['type'], IconName> = { CALL: 'phone', WHATSAPP: 'chat', MAP: 'pin', LINK: 'link' };

const STYLE_CLASSES = {
  PRIMARY: 'bg-accent text-on-accent',
  SECONDARY: 'bg-accent-soft text-accent',
  OUTLINE: 'border border-line bg-surface text-ink',
} as const;

function PreviewButton({ action }: { action: ReadAction }) {
  return (
    <span className={`flex min-h-12 items-center justify-center gap-2 rounded-md px-3 text-label ${STYLE_CLASSES[action.style]}`}>
      <Icon name={ACTION_ICONS[action.type]} size={18} className="shrink-0" />
      <span className="min-w-0 truncate">{action.label}</span>
    </span>
  );
}

/**
 * What a listener sees when they identify the ad, drawn from the card by the same tolerant reader the
 * listener app follows (so the preview can't disagree with the app): the buttons in order, the fifth
 * and sixth under "More options", and the "update the app" note for a card from a newer version. The
 * buttons here are a picture, not controls. `phoneWidth` is the phone's screen width in CSS pixels.
 */
export function ListenerCardPreview({
  card,
  adTitle,
  clientName,
  stationName,
  frequencyLabel,
  phoneWidth = 360,
}: {
  card: unknown;
  adTitle: string;
  clientName: string;
  stationName: string;
  frequencyLabel: string;
  phoneWidth?: number;
}) {
  const read = readActionCard(card);
  return (
    <div className="flex justify-center">
      <div
        role="group"
        aria-label={`Preview of what listeners see, on a ${phoneWidth} pixel wide phone`}
        style={{ width: phoneWidth + 36 }}
        className="box-border flex max-w-full flex-col gap-2 rounded-[1.75rem] border-[6px] border-ink bg-ground p-3"
      >
        <span className="text-caption text-muted">
          {clientName} · via {stationName} · {frequencyLabel}
        </span>
        <span className="font-display text-heading">{adTitle}</span>
        {read.visibleActions.map((action) => (
          <PreviewButton key={action.id} action={action} />
        ))}
        {read.moreOptionsActions.length > 0 ? (
          <details className="flex flex-col gap-2">
            <summary className="flex min-h-11 cursor-pointer items-center justify-center rounded-md text-label text-muted">More options</summary>
            <div className="flex flex-col gap-2">
              {read.moreOptionsActions.map((action) => (
                <PreviewButton key={action.id} action={action} />
              ))}
            </div>
          </details>
        ) : null}
        {read.showsUpdateAppHint ? <span className="rounded-md bg-warning-soft px-3 py-2 text-caption text-warning">Update the Look Up app to see these buttons.</span> : null}
        {read.visibleActions.length === 0 && !read.showsUpdateAppHint ? <span className="px-1 py-3 text-caption text-muted">No buttons yet.</span> : null}
      </div>
    </div>
  );
}
