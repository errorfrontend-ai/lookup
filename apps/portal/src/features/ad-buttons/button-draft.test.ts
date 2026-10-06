import { describe, expect, it } from 'vitest';
import { actionCardFixture } from '../../test/ad-fixtures';
import { type ButtonDraft, draftsFromCard, moveDraft, newButtonDraft, STARTING_LABELS, styleForPosition } from './button-draft';
import { validateButtonDrafts } from './validate-button-drafts';

const draftNamed = (key: string): ButtonDraft => newButtonDraft('CALL', key);
const keys = (drafts: ButtonDraft[]) => drafts.map((draft) => draft.key);

describe('button drafts', () => {
  describe('a new button', () => {
    it('starts with a label for its kind, so it is never blank, and nothing else filled in', () => {
      for (const kind of ['CALL', 'WHATSAPP', 'MAP', 'LINK'] as const) {
        expect(newButtonDraft(kind)).toMatchObject({ kind, label: STARTING_LABELS[kind], phoneText: '', firstMessage: '', webAddressText: '', locationText: '', placeName: '' });
      }
    });

    it('gets its own id, so taps count against it', () => {
      expect(newButtonDraft('CALL').key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(newButtonDraft('CALL').key).not.toBe(newButtonDraft('CALL').key);
    });
  });

  describe('which style each position gets', () => {
    it('makes the first the main button, the second quieter, and the rest outlined', () => {
      expect([0, 1, 2, 3, 5].map(styleForPosition)).toEqual(['PRIMARY', 'SECONDARY', 'OUTLINE', 'OUTLINE', 'OUTLINE']);
    });
  });

  describe('editing a saved card', () => {
    it('shows each saved button as typed text, with the phone number written the way people read it', () => {
      const drafts = draftsFromCard(actionCardFixture()) as ButtonDraft[];
      expect(drafts).toHaveLength(3);
      expect(drafts[0]).toMatchObject({ kind: 'CALL', label: 'Call Brand A', phoneText: '+260 97 712 3456', key: '0190f1a2-0000-7000-8000-0000000000e1' });
      expect(drafts[1]).toMatchObject({ kind: 'WHATSAPP', phoneText: '+260 96 600 0111', firstMessage: 'Hello there' });
      expect(drafts[2]).toMatchObject({ kind: 'MAP', locationText: '-15.4167, 28.2833', placeName: 'Cairo Road, Lusaka' });
    });

    it('makes the very same card again when nothing was changed, ids and all', () => {
      const original = actionCardFixture();
      const drafts = draftsFromCard(original) as ButtonDraft[];
      expect(validateButtonDrafts(drafts).card).toEqual(original);
    });

    it('round-trips a website button too', () => {
      const original = { schema_version: 1, layout: 'VERTICAL_STACK', actions: [{ type: 'LINK', id: '0190f1a2-0000-7000-8000-0000000000e9', label: 'Book online', style: 'PRIMARY', url: 'https://brand.co.zm/book?x=1' }] };
      const drafts = draftsFromCard(original) as ButtonDraft[];
      expect(drafts[0]).toMatchObject({ kind: 'LINK', webAddressText: 'https://brand.co.zm/book?x=1' });
      expect(validateButtonDrafts(drafts).card).toEqual(original);
    });

    it('treats an ad with no card as an empty list', () => {
      expect(draftsFromCard(null)).toEqual([]);
      expect(draftsFromCard(undefined)).toEqual([]);
    });

    it('will not offer to edit a card it cannot read, because saving would drop what it could not read', () => {
      expect(draftsFromCard({ schema_version: 2, layout: 'VERTICAL_STACK', actions: [] })).toBeNull();
      expect(draftsFromCard({ schema_version: 1, layout: 'VERTICAL_STACK', actions: [{ type: 'SHARE', id: '0190f1a2-0000-7000-8000-0000000000e9', label: 'Share', style: 'PRIMARY' }] })).toBeNull();
      expect(draftsFromCard('not a card')).toBeNull();
      expect(draftsFromCard({})).toBeNull();
    });
  });

  describe('moving a button', () => {
    const three = [draftNamed('a'), draftNamed('b'), draftNamed('c')];

    it('moves it up or down one place', () => {
      expect(keys(moveDraft(three, 'b', 'up'))).toEqual(['b', 'a', 'c']);
      expect(keys(moveDraft(three, 'b', 'down'))).toEqual(['a', 'c', 'b']);
    });

    it('leaves the first where it is when moved up, and the last when moved down', () => {
      expect(keys(moveDraft(three, 'a', 'up'))).toEqual(['a', 'b', 'c']);
      expect(keys(moveDraft(three, 'c', 'down'))).toEqual(['a', 'b', 'c']);
    });

    it('ignores a button that is not there, and never changes the list it was given', () => {
      const before = keys(three);
      expect(keys(moveDraft(three, 'nope', 'up'))).toEqual(['a', 'b', 'c']);
      moveDraft(three, 'c', 'up');
      expect(keys(three)).toEqual(before);
    });
  });
});
