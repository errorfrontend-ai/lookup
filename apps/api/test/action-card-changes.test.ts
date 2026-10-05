import type { ActionCard } from '@lookup/contracts';
import { describe, expect, it } from 'vitest';
import { describeActionCardChanges } from '../src/features/action-cards/action-card-changes.js';

const CALL_ID = '0190f1a2-0000-7000-8000-0000000000c1';
const WHATSAPP_ID = '0190f1a2-0000-7000-8000-0000000000c2';
const LINK_ID = '0190f1a2-0000-7000-8000-0000000000c3';

const card = (actions: ActionCard['actions']): ActionCard => ({ schema_version: 1, layout: 'VERTICAL_STACK', actions }) as ActionCard;
const callButton = { type: 'CALL', id: CALL_ID, label: 'Call us', style: 'PRIMARY', phone_number_e164: '+260977123456' } as const;
const whatsAppButton = { type: 'WHATSAPP', id: WHATSAPP_ID, label: 'Chat', style: 'SECONDARY', phone_number_e164: '+260966000111' } as const;
const linkButton = { type: 'LINK', id: LINK_ID, label: 'Website', style: 'OUTLINE', url: 'https://example.co.zm' } as const;

/** S2-AUDIT-02, S2-CARDS-21: the audit trail names changed fields by path, never their values. */
describe('describeActionCardChanges', () => {
  it('a first card lists its fields and buttons as added', () => {
    expect(describeActionCardChanges(null, card([callButton]))).toEqual([
      { path: 'schema_version', change: 'added' },
      { path: 'layout', change: 'added' },
      { path: `actions.${CALL_ID}`, change: 'added' },
    ]);
  });

  it('names the one field that changed on a button, matched by the button id', () => {
    const changes = describeActionCardChanges(
      card([callButton, whatsAppButton]),
      card([callButton, { ...whatsAppButton, phone_number_e164: '+260955000222' }]),
    );
    expect(changes).toEqual([{ path: `actions.${WHATSAPP_ID}.phone_number_e164`, change: 'changed' }]);
    expect(JSON.stringify(changes)).not.toMatch(/\+260/);
  });

  it('reports removed buttons, added buttons and a new order', () => {
    expect(describeActionCardChanges(card([callButton, whatsAppButton]), card([linkButton, callButton]))).toEqual([
      { path: `actions.${LINK_ID}`, change: 'added' },
      { path: `actions.${CALL_ID}.position`, change: 'changed' },
      { path: `actions.${WHATSAPP_ID}`, change: 'removed' },
    ]);
  });

  it('reports nothing when the card is saved unchanged', () => {
    expect(describeActionCardChanges(card([callButton]), card([callButton]))).toEqual([]);
  });
});
