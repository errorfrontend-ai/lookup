import { buildActionUri, formatPhoneNumberForDisplay, type ReadAction, readActionCard } from '@lookup/contracts';
import { useState } from 'react';
import type { AdDetail } from '@lookup/contracts';
import { Icon, type IconName } from '../../../components/icons';
import { ListenerCardPreview } from '../../../components/listener-card-preview';
import type { MemberStation } from '../../stations/use-current-station';

const TYPE_WORDS: Record<ReadAction['type'], string> = { CALL: 'Call', WHATSAPP: 'WhatsApp', MAP: 'Directions', LINK: 'Website' };
const TYPE_ICONS: Record<ReadAction['type'], IconName> = { CALL: 'phone', WHATSAPP: 'chat', MAP: 'pin', LINK: 'link' };
const PHONE_WIDTHS = [320, 411] as const;

/** Where a button takes the listener, written out for the station to check. */
function describeDestination(action: ReadAction): string {
  switch (action.type) {
    case 'CALL':
      return formatPhoneNumberForDisplay(action.phoneNumberE164);
    case 'WHATSAPP':
      return action.prefilledText ? `${formatPhoneNumberForDisplay(action.phoneNumberE164)} · first message: “${action.prefilledText}”` : formatPhoneNumberForDisplay(action.phoneNumberE164);
    case 'MAP':
      return action.placeName ? `${action.placeName} (${action.latitude.toFixed(4)}, ${action.longitude.toFixed(4)})` : `${action.latitude.toFixed(4)}, ${action.longitude.toFixed(4)}`;
    case 'LINK':
      return action.url;
  }
}

/** The buttons: a picture of what listeners see at two phone widths, and each button written out with a way to try it. */
export function AdButtonsTab({ ad, station }: { ad: AdDetail; station: MemberStation }) {
  const [phoneWidth, setPhoneWidth] = useState<(typeof PHONE_WIDTHS)[number]>(320);
  if (!ad.actionCard) {
    return (
      <section className="rounded-lg border border-line-soft bg-surface p-5">
        <h2 className="text-heading">No buttons yet</h2>
        <p className="mt-1 text-body text-muted">Listeners who identify this ad see nothing to tap until it has buttons.</p>
      </section>
    );
  }
  const read = readActionCard(ad.actionCard);
  const actions = [...read.visibleActions, ...read.moreOptionsActions];

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_26rem]">
      <section aria-label="Buttons" className="flex flex-col gap-3 rounded-lg border border-line-soft bg-surface p-5">
        <h2 className="text-heading">Buttons</h2>
        <p className="text-caption text-muted">
          {actions.length === 1 ? '1 button' : `${actions.length} buttons`} · the first is the main one
        </p>
        <ol className="m-0 flex list-none flex-col divide-y divide-line-soft p-0">
          {actions.map((action) => {
            const address = buildActionUri(action);
            return (
              <li key={action.id} className="flex items-start gap-3 py-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-pill bg-accent-soft text-accent">
                  <Icon name={TYPE_ICONS[action.type]} size={18} />
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-label">{action.label}</span>
                  <span className="text-caption text-muted">{TYPE_WORDS[action.type]}</span>
                  <span className="break-words text-body">{describeDestination(action)}</span>
                </div>
                {address ? (
                  <a
                    href={address}
                    target={address.startsWith('https:') ? '_blank' : undefined}
                    rel="noopener noreferrer"
                    aria-label={`Try “${action.label}”`}
                    className="flex min-h-11 items-center rounded-md px-3 text-label text-accent hover:bg-accent-soft"
                  >
                    Try it
                  </a>
                ) : null}
              </li>
            );
          })}
        </ol>
      </section>

      <section aria-label="What listeners see" className="flex h-fit flex-col gap-3 rounded-lg border border-line-soft bg-surface p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-heading">What listeners see</h2>
          <div role="group" aria-label="Preview width" className="flex overflow-hidden rounded-md border border-line">
            {PHONE_WIDTHS.map((width) => (
              <button
                key={width}
                type="button"
                aria-pressed={phoneWidth === width}
                onClick={() => setPhoneWidth(width)}
                className={`min-h-11 px-3 text-label ${phoneWidth === width ? 'bg-ink text-surface' : 'bg-surface text-ink'}`}
              >
                {width === 320 ? 'Small phone · 320' : 'Large phone · 411'}
              </button>
            ))}
          </div>
        </div>
        <ListenerCardPreview card={ad.actionCard} adTitle={ad.title} clientName={ad.client.name} stationName={station.name} frequencyLabel={station.frequencyLabel} phoneWidth={phoneWidth} />
      </section>
    </div>
  );
}
