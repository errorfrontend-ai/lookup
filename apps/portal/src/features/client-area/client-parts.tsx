import type { ClientFigures, ClientStationContact } from '@lookup/contracts';
import { Button } from '../../components/button';
import { EmptyState } from '../../components/empty-state';
import { ErrorNotice } from '../../components/error-notice';
import { FigureTile } from '../../components/figure-tile';
import { Icon } from '../../components/icons';
import { useSpreadsheetDownload } from './use-client-area';

/** What a person with no access left sees, wherever they arrive in the client area (P5C-ONBOARDING-06). */
export function NoAdvertsToView() {
  return (
    <EmptyState icon="ads" title="You can't view any adverts right now">
      Ask the station to invite you again. Their invitation email has the link to accept.
    </EmptyState>
  );
}

/** The four buttons listeners tap, as a client's figures name them, with what each tile says it counts. */
export const TAP_KINDS = [
  { key: 'calls', title: 'Calls', note: 'Taps on Call' },
  { key: 'whatsApp', title: 'WhatsApp', note: 'Taps on WhatsApp' },
  { key: 'directions', title: 'Directions', note: 'Taps on Directions' },
  { key: 'website', title: 'Website', note: 'Taps on Website' },
] as const;

/** Heard, then taps by button type, as tiles: two to a row on a phone (Heard across both), five in a row from 768 px. */
export function ClientFigureTiles({ figures, label }: { figures: ClientFigures; label: string }) {
  return (
    <dl aria-label={label} className="grid grid-cols-2 gap-3 md:grid-cols-5">
      <FigureTile className="col-span-2 md:col-span-1" title="Heard" value={figures.heard.toLocaleString('en-US')} note="Times listeners identified your adverts" />
      {TAP_KINDS.map((kind) => (
        <FigureTile key={kind.key} title={kind.title} value={figures[kind.key].toLocaleString('en-US')} note={kind.note} />
      ))}
    </dl>
  );
}

/**
 * What a client may not do, and who to ask (P5C-DASHBOARD-06, P5C-ADVERT-04): "View only. To change this ad or its buttons,
 * contact Station A on +260…", the number a tap away on a phone.
 */
export function ViewOnlyNote({ stationName, contact, what }: { stationName: string | null; contact: ClientStationContact; what: 'an ad' | 'this ad' }) {
  const station = stationName ?? 'the station';
  return (
    <p role="note" className="flex items-start gap-3 rounded-lg border border-line-soft bg-surface p-4 text-body">
      <Icon name="info" size={20} className="mt-0.5 shrink-0 text-muted" />
      <span>
        {`View only. To change ${what} or its buttons, contact ${contact.name ? `${contact.name} at ` : ''}${station}`}
        {contact.phoneNumberE164 ? (
          <>
            {' on '}
            <a href={`tel:${contact.phoneNumberE164}`} className="text-accent underline">
              {contact.phoneNumberE164}
            </a>
          </>
        ) : null}
        .
      </span>
    </p>
  );
}

/** "Download as spreadsheet (CSV)" for one station (P5C-EXPORT-01): the last 30 days, one row per advert per day. */
export function SpreadsheetButton({ stationId, stationName }: { stationId: string; stationName: string | null }) {
  const download = useSpreadsheetDownload(stationId);
  return (
    <div className="flex flex-col items-start gap-2">
      <Button variant="secondary" className="min-h-12" onClick={() => download.mutate()} isBusy={download.isPending} busyLabel="Preparing the spreadsheet…">
        Download as spreadsheet (CSV) <span className="sr-only">{`for ${stationName ?? 'this station'}`}</span>
      </Button>
      <span className="text-caption text-muted">The last 30 days: one row per advert per day.</span>
      {download.isError ? <ErrorNotice error={download.error} title="We couldn't prepare the spreadsheet" /> : null}
    </div>
  );
}
