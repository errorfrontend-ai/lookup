import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { actionCardFixture } from '../test/ad-fixtures';
import { ListenerCardPreview } from './listener-card-preview';

function renderPreview(card: unknown, phoneWidth?: number) {
  return render(<ListenerCardPreview card={card} adTitle="Summer service offer" clientName="Brand A" stationName="Radio Phoenix" frequencyLabel="89.5 FM" phoneWidth={phoneWidth} />);
}

describe('ListenerCardPreview', () => {
  it('shows who the ad is for, its title, and each button in order', () => {
    renderPreview(actionCardFixture());
    const frame = screen.getByRole('group', { name: /Preview of what listeners see/ });
    expect(within(frame).getByText('Brand A · via Radio Phoenix · 89.5 FM')).toBeInTheDocument();
    expect(within(frame).getByText('Summer service offer')).toBeInTheDocument();
    expect(['Call Brand A', 'Chat on WhatsApp', 'Get directions'].every((label) => within(frame).getByText(label))).toBe(true);
    const labels = [...frame.querySelectorAll('span.min-w-0')].map((label) => label.textContent);
    expect(labels).toEqual(['Call Brand A', 'Chat on WhatsApp', 'Get directions']);
  });

  it('draws the phone at the width asked for, so overflow is seen before publishing', () => {
    const { rerender } = renderPreview(actionCardFixture(), 320);
    expect(screen.getByRole('group', { name: /320 pixel wide/ })).toHaveStyle({ width: '356px' });
    rerender(<ListenerCardPreview card={actionCardFixture()} adTitle="x" clientName="y" stationName="z" frequencyLabel="1 FM" phoneWidth={411} />);
    expect(screen.getByRole('group', { name: /411 pixel wide/ })).toHaveStyle({ width: '447px' });
  });

  it('puts buttons beyond the fourth under "More options", as the app does', () => {
    const card = actionCardFixture();
    const extra = (number: number) => ({ type: 'LINK', id: `0190f1a2-0000-7000-8000-0000000000f${number}`, label: `Extra ${number}`, style: 'OUTLINE', url: `https://example.co.zm/${number}` });
    // Three buttons plus three more: the fourth is shown, the fifth and sixth go under "More options".
    (card.actions as unknown[]).push(extra(1), extra(2), extra(3));
    renderPreview(card);
    const more = screen.getByText('More options').closest('details') as HTMLElement;
    expect(within(more).getAllByText(/^Extra /).map((element) => element.textContent)).toEqual(['Extra 2', 'Extra 3']);
    expect(within(more).queryByText('Call Brand A')).not.toBeInTheDocument();
    expect(screen.getByText('Extra 1').closest('details')).toBeNull();
  });

  it('skips a button whose link is not safe, rather than showing something broken', () => {
    const card = actionCardFixture();
    (card.actions as unknown[]).push({ type: 'LINK', id: '0190f1a2-0000-7000-8000-0000000000f9', label: 'Unsafe', style: 'OUTLINE', url: 'javascript:alert(1)' });
    renderPreview(card);
    expect(screen.queryByText('Unsafe')).not.toBeInTheDocument();
    expect(screen.getByText('Call Brand A')).toBeInTheDocument();
  });

  it('says to update the app for a card from a newer version, and shows no buttons', () => {
    renderPreview({ schema_version: 99, layout: 'VERTICAL_STACK', actions: [] });
    expect(screen.getByText('Update the Look Up app to see these buttons.')).toBeInTheDocument();
    expect(screen.queryByText('No buttons yet.')).not.toBeInTheDocument();
  });

  it('says there are no buttons yet for an empty or missing card, and never throws', () => {
    for (const card of [null, undefined, 'not a card', 42, { schema_version: 1, layout: 'VERTICAL_STACK', actions: [] }]) {
      const { unmount } = renderPreview(card);
      expect(screen.getByText('No buttons yet.')).toBeInTheDocument();
      unmount();
    }
  });

  it('never shows a phone number, link or address: only labels', () => {
    const { container } = renderPreview(actionCardFixture());
    expect(container.textContent).not.toMatch(/260|example|wa\.me|maps|Hello there|Cairo/);
  });
});
