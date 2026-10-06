import { buildActionUri, formatPhoneNumberForDisplay, MAXIMUM_LABEL_LENGTH, MAXIMUM_PLACE_NAME_LENGTH, MAXIMUM_PREFILLED_TEXT_LENGTH, normalizeZambianPhoneInput } from '@lookup/contracts';
import { useEffect, useRef } from 'react';
import { Icon, type IconName } from '../../components/icons';
import { SelectField } from '../../components/select-field';
import { TextAreaField } from '../../components/text-area-field';
import { TextField } from '../../components/text-field';
import { BUTTON_KIND_WORDS } from '../../plain-words/button-words';
import { BUTTON_KINDS, type ButtonDraft, type ButtonField, type ButtonKind, STARTING_LABELS } from './button-draft';
import { parseMapLocation } from './parse-map-location';
import { readWebAddress } from './read-web-address';
import type { ButtonFieldProblems } from './validate-button-drafts';

const KIND_ICONS: Record<ButtonKind, IconName> = { CALL: 'phone', WHATSAPP: 'chat', MAP: 'pin', LINK: 'link' };

const ICON_BUTTON_CLASSES = 'flex size-11 items-center justify-center rounded-md border border-line bg-surface text-ink hover:bg-ground disabled:cursor-not-allowed disabled:opacity-40';

function countCharacters(text: string): number {
  return [...text].length;
}

/** Shows, in plain words, what the typed text was understood as, so the station can check it before listeners do. */
function Understood({ children }: { children: React.ReactNode }) {
  return <p className="flex flex-wrap items-center gap-x-2 text-caption text-success">{children}</p>;
}

function PhoneField({ draft, problem, onChange, onTouch }: FieldsProps) {
  const understood = normalizeZambianPhoneInput(draft.phoneText);
  return (
    <div className="flex flex-col gap-1.5">
      <TextField
        label="Phone number"
        hint="Like 0977 123 456. Numbers from other countries need their + code."
        type="tel"
        inputMode="tel"
        autoComplete="off"
        value={draft.phoneText}
        onChange={(event) => onChange({ phoneText: event.target.value })}
        onBlur={() => onTouch('phone')}
        error={problem.phone}
      />
      {understood ? (
        <Understood>
          <Icon name="check" size={14} />
          {draft.kind === 'WHATSAPP' ? 'Opens a chat with' : 'Calls'} {formatPhoneNumberForDisplay(understood)}
        </Understood>
      ) : null}
    </div>
  );
}

function WhatsAppFields(props: FieldsProps) {
  const { draft, problem, onChange, onTouch } = props;
  return (
    <>
      <PhoneField {...props} />
      <TextAreaField
        label="First message (optional)"
        hint="What the chat starts with. The listener can change it before sending."
        value={draft.firstMessage}
        onChange={(event) => onChange({ firstMessage: event.target.value })}
        onBlur={() => onTouch('firstMessage')}
        counter={`${countCharacters(draft.firstMessage)} / ${MAXIMUM_PREFILLED_TEXT_LENGTH}`}
        error={problem.firstMessage}
      />
    </>
  );
}

function MapFields({ draft, problem, onChange, onTouch }: FieldsProps) {
  const location = parseMapLocation(draft.locationText);
  const address = location.kind === 'found' ? buildActionUri({ type: 'MAP', id: draft.key, label: draft.label, style: 'PRIMARY', latitude: location.latitude, longitude: location.longitude }) : null;
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <TextField
          label="Location"
          hint="Paste a Google Maps link, or type latitude and longitude, like -15.4167, 28.2833."
          autoComplete="off"
          value={draft.locationText}
          onChange={(event) => onChange({ locationText: event.target.value })}
          onBlur={() => onTouch('location')}
          error={problem.location}
        />
        {location.kind === 'found' ? (
          <Understood>
            <Icon name="check" size={14} />
            Understood: {location.latitude}, {location.longitude}
            {address ? (
              <a href={address} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-4">
                Check on Google Maps
              </a>
            ) : null}
          </Understood>
        ) : null}
      </div>
      <TextField
        label="Place name (optional)"
        hint="A name for the place, like “Cairo Road branch”."
        autoComplete="off"
        value={draft.placeName}
        onChange={(event) => onChange({ placeName: event.target.value })}
        onBlur={() => onTouch('placeName')}
        maxLength={MAXIMUM_PLACE_NAME_LENGTH + 20}
        counter={`${countCharacters(draft.placeName)} / ${MAXIMUM_PLACE_NAME_LENGTH}`}
        error={problem.placeName}
      />
    </>
  );
}

function LinkFields({ draft, problem, onChange, onTouch }: FieldsProps) {
  const address = readWebAddress(draft.webAddressText);
  return (
    <div className="flex flex-col gap-1.5">
      <TextField
        label="Web address"
        hint="Like brand.co.zm/offer. Use the full address, not a short link."
        inputMode="url"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        value={draft.webAddressText}
        onChange={(event) => onChange({ webAddressText: event.target.value })}
        onBlur={() => onTouch('webAddress')}
        error={problem.webAddress}
      />
      {address.kind === 'found' ? (
        <Understood>
          <Icon name="check" size={14} />
          Opens {address.url}
          <a href={address.url} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-4">
            Try the link
          </a>
        </Understood>
      ) : null}
    </div>
  );
}

interface FieldsProps {
  draft: ButtonDraft;
  problem: ButtonFieldProblems;
  onChange: (changes: Partial<ButtonDraft>) => void;
  onTouch: (field: ButtonField) => void;
}

/** One button in the editor: its kind, its label, and what it goes to. */
export function ButtonRow({
  draft,
  position,
  total,
  problem,
  onChange,
  onTouch,
  onMove,
  onRemove,
  shouldFocusOnMount,
}: {
  draft: ButtonDraft;
  position: number;
  total: number;
  problem: ButtonFieldProblems;
  onChange: (changes: Partial<ButtonDraft>) => void;
  onTouch: (field: ButtonField) => void;
  onMove: (direction: 'up' | 'down') => void;
  onRemove: () => void;
  shouldFocusOnMount: boolean;
}) {
  const rowReference = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (shouldFocusOnMount) rowReference.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, [shouldFocusOnMount]);

  const name = draft.label.trim() || `button ${position + 1}`;
  const fieldProps: FieldsProps = { draft, problem, onChange, onTouch };

  const changeKind = (kind: ButtonKind) => {
    // A label left as the starting words follows the kind; one the person wrote stays.
    const isStartingLabel = draft.label === STARTING_LABELS[draft.kind];
    onChange({ kind, ...(isStartingLabel ? { label: STARTING_LABELS[kind] } : {}) });
  };

  return (
    <li ref={rowReference} aria-label={`Button ${position + 1}`} className="flex flex-col gap-4 rounded-lg border border-line-soft bg-surface p-4">
      <div className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-pill bg-accent-soft text-accent">
          <Icon name={KIND_ICONS[draft.kind]} size={18} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-label">Button {position + 1}</span>
          <span className="text-caption text-muted">{position === 0 ? 'The main button' : BUTTON_KIND_WORDS[draft.kind].name}</span>
        </div>
        <button type="button" disabled={position === 0} onClick={() => onMove('up')} aria-label={`Move “${name}” up`} className={ICON_BUTTON_CLASSES}>
          <Icon name="arrowUp" size={18} />
        </button>
        <button type="button" disabled={position === total - 1} onClick={() => onMove('down')} aria-label={`Move “${name}” down`} className={ICON_BUTTON_CLASSES}>
          <Icon name="arrowDown" size={18} />
        </button>
        <button type="button" onClick={onRemove} aria-label={`Remove “${name}”`} className={`${ICON_BUTTON_CLASSES} text-danger`}>
          <Icon name="trash" size={18} />
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <SelectField label="Type" hint={BUTTON_KIND_WORDS[draft.kind].description} value={draft.kind} onChange={(event) => changeKind(event.target.value as ButtonKind)}>
          {BUTTON_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {BUTTON_KIND_WORDS[kind].name}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Label"
          hint="What the button says."
          autoComplete="off"
          value={draft.label}
          onChange={(event) => onChange({ label: event.target.value })}
          onBlur={() => onTouch('label')}
          maxLength={MAXIMUM_LABEL_LENGTH + 20}
          counter={`${countCharacters(draft.label)} / ${MAXIMUM_LABEL_LENGTH}`}
          error={problem.label}
        />
      </div>

      {draft.kind === 'CALL' ? <PhoneField {...fieldProps} /> : null}
      {draft.kind === 'WHATSAPP' ? <WhatsAppFields {...fieldProps} /> : null}
      {draft.kind === 'MAP' ? <MapFields {...fieldProps} /> : null}
      {draft.kind === 'LINK' ? <LinkFields {...fieldProps} /> : null}
    </li>
  );
}
