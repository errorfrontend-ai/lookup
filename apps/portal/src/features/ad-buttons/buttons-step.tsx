import type { AdDetail } from '@lookup/contracts';
import { useState } from 'react';
import { ListenerCardPreview } from '../../components/listener-card-preview';
import { PhoneWidthToggle, type PhoneWidth } from '../../components/phone-width-toggle';
import { LARGE_SCREEN_QUERY, useMediaQuery } from '../../components/use-media-query';
import type { MemberStation } from '../stations/use-current-station';
import { ButtonsEditor } from './buttons-editor';
import type { ButtonDraft } from './button-draft';
import type { ButtonFieldProblems, ButtonValidation } from './validate-button-drafts';

function PreviewPanel({ ad, station, validation }: { ad: AdDetail; station: MemberStation; validation: ButtonValidation }) {
  const [phoneWidth, setPhoneWidth] = useState<PhoneWidth>(320);
  return (
    <section aria-label="What listeners see" className="flex h-fit flex-col gap-3 rounded-lg border border-line-soft bg-surface p-5 lg:sticky lg:top-28">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-heading">What listeners see</h2>
        <PhoneWidthToggle value={phoneWidth} onChange={setPhoneWidth} />
      </div>
      <ListenerCardPreview card={validation.previewCard} adTitle={ad.title} clientName={ad.client.name} stationName={station.name} frequencyLabel={station.frequencyLabel} phoneWidth={phoneWidth} />
      {validation.hiddenFromPreview.length > 0 ? (
        <p className="rounded-md bg-warning-soft px-3 py-2 text-caption text-warning">
          Not shown until fixed: {validation.hiddenFromPreview.map((label) => `“${label}”`).join(', ')}.
        </p>
      ) : null}
    </section>
  );
}

/**
 * The buttons step: the editor, and what listeners will see as you go. Side by side on a wide
 * screen; on a phone there is room for one at a time, so "Edit" and "Preview" switch between them.
 */
export function ButtonsStep({
  ad,
  station,
  drafts,
  onChange,
  validation,
  apiProblems,
  showAllProblems,
}: {
  ad: AdDetail;
  station: MemberStation;
  drafts: ButtonDraft[];
  onChange: (drafts: ButtonDraft[]) => void;
  validation: ButtonValidation;
  apiProblems: ReadonlyMap<string, ButtonFieldProblems>;
  showAllProblems: boolean;
}) {
  const isLargeScreen = useMediaQuery(LARGE_SCREEN_QUERY);
  const [pane, setPane] = useState<'edit' | 'preview'>('edit');

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-display">Add the buttons</h1>
        <p className="text-body text-muted">What listeners can tap after they identify this ad. They see them in the order below.</p>
      </div>

      {!isLargeScreen ? (
        <div role="group" aria-label="Show" className="flex self-start overflow-hidden rounded-md border border-line">
          {(['edit', 'preview'] as const).map((choice) => (
            <button
              key={choice}
              type="button"
              aria-pressed={pane === choice}
              onClick={() => setPane(choice)}
              className={`min-h-11 px-5 text-label ${pane === choice ? 'bg-ink text-surface' : 'bg-surface text-ink'}`}
            >
              {choice === 'edit' ? 'Edit' : 'Preview'}
            </button>
          ))}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
        {/* Both stay on the page and one is hidden on a phone, so what was typed and what was left are not lost by looking at the preview. */}
        <div hidden={!isLargeScreen && pane !== 'edit'}>
          <ButtonsEditor drafts={drafts} onChange={onChange} validation={validation} apiProblems={apiProblems} showAllProblems={showAllProblems} />
        </div>
        <div hidden={!isLargeScreen && pane !== 'preview'}>
          <PreviewPanel ad={ad} station={station} validation={validation} />
        </div>
      </div>
    </div>
  );
}
