import { useRef, useState } from 'react';
import { Button } from '../../components/button';
import { Icon } from '../../components/icons';
import { BUTTON_KIND_WORDS } from '../../plain-words/button-words';
import { BUTTON_KINDS, type ButtonDraft, type ButtonField, type ButtonKind, MAXIMUM_BUTTONS, moveDraft, newButtonDraft } from './button-draft';
import { ButtonRow } from './button-row';
import type { ButtonFieldProblems, ButtonValidation } from './validate-button-drafts';

const KIND_ICONS = { CALL: 'phone', WHATSAPP: 'chat', MAP: 'pin', LINK: 'link' } as const;

/**
 * The list of buttons being edited: each with its fields, a way to move or remove it, and the
 * "add a button" choices. A problem is shown for a field once the person has left it, or for every
 * field after a failed save, so a new row is never shouted at before anything has been typed.
 */
export function ButtonsEditor({
  drafts,
  onChange,
  validation,
  apiProblems,
  showAllProblems,
}: {
  drafts: ButtonDraft[];
  onChange: (drafts: ButtonDraft[]) => void;
  validation: ButtonValidation;
  /** Problems the API reported for the last save, in the same words. They stay until the buttons are changed. */
  apiProblems: ReadonlyMap<string, ButtonFieldProblems>;
  showAllProblems: boolean;
}) {
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [lastAddedKey, setLastAddedKey] = useState<string | null>(null);
  const headingReference = useRef<HTMLHeadingElement>(null);

  const problemsShownFor = (draft: ButtonDraft): ButtonFieldProblems => {
    const shown: ButtonFieldProblems = {};
    for (const [field, words] of Object.entries(validation.problemsByKey.get(draft.key) ?? {})) {
      if (showAllProblems || touched.has(`${draft.key}:${field}`)) shown[field as ButtonField] = words;
    }
    return { ...shown, ...apiProblems.get(draft.key) };
  };

  const add = (kind: ButtonKind) => {
    const draft = newButtonDraft(kind);
    setLastAddedKey(draft.key);
    onChange([...drafts, draft]);
  };

  const remove = (key: string) => {
    onChange(drafts.filter((draft) => draft.key !== key));
    // The row the person was on is gone: put them back at the top of the list, not at the top of the page.
    headingReference.current?.focus();
  };

  const isFull = drafts.length >= MAXIMUM_BUTTONS;
  const cardProblem = showAllProblems || drafts.length > MAXIMUM_BUTTONS ? validation.cardProblem : null;

  return (
    <section aria-labelledby="buttons-editor-heading" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="buttons-editor-heading" ref={headingReference} tabIndex={-1} className="text-heading outline-none">
          Buttons
        </h2>
        <p className="text-caption text-muted">
          {drafts.length === 0 ? 'None yet.' : drafts.length === 1 ? '1 button' : `${drafts.length} buttons`} · up to {MAXIMUM_BUTTONS}. The first is the main one.
        </p>
      </div>

      {showAllProblems && validation.problemCount > 0 ? (
        <p role="alert" className="rounded-md border border-danger bg-danger-soft px-4 py-3 text-body font-bold text-danger">
          {validation.problemCount === 1 ? '1 thing' : `${validation.problemCount} things`} to fix before these buttons can be saved.
        </p>
      ) : null}

      {drafts.length > 0 ? (
        <ol className="m-0 flex list-none flex-col gap-3 p-0">
          {drafts.map((draft, position) => (
            <ButtonRow
              key={draft.key}
              draft={draft}
              position={position}
              total={drafts.length}
              problem={problemsShownFor(draft)}
              onChange={(changes) => onChange(drafts.map((candidate) => (candidate.key === draft.key ? { ...candidate, ...changes } : candidate)))}
              onTouch={(field) => setTouched((current) => new Set(current).add(`${draft.key}:${field}`))}
              onMove={(direction) => onChange(moveDraft(drafts, draft.key, direction))}
              onRemove={() => remove(draft.key)}
              shouldFocusOnMount={draft.key === lastAddedKey}
            />
          ))}
        </ol>
      ) : (
        <p className="rounded-lg border border-dashed border-line bg-surface p-4 text-body text-muted">No buttons yet. Choose the first one below: a call, a WhatsApp chat, directions or a website.</p>
      )}

      {cardProblem ? (
        <p role="alert" className="text-body font-bold text-danger">
          {cardProblem}
        </p>
      ) : null}

      <fieldset className="flex flex-col gap-2 border-0 p-0">
        <legend className="mb-2 text-label">{drafts.length === 0 ? 'Add the first button' : 'Add another button'}</legend>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {BUTTON_KINDS.map((kind) => (
            <Button key={kind} variant="secondary" disabled={isFull} onClick={() => add(kind)} aria-label={`Add a ${BUTTON_KIND_WORDS[kind].name} button`}>
              <Icon name={KIND_ICONS[kind]} size={18} />
              {BUTTON_KIND_WORDS[kind].addLabel}
            </Button>
          ))}
        </div>
        {isFull ? <p className="text-caption text-muted">You have {MAXIMUM_BUTTONS} buttons, the most a card can hold. Remove one to add another.</p> : null}
      </fieldset>
    </section>
  );
}
