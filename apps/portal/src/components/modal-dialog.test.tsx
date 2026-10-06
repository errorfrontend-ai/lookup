import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog, ModalDialog } from './modal-dialog';

const person = userEvent.setup({ delay: null });

function Opener() {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setIsOpen(true)}>
        Open it
      </button>
      {isOpen ? (
        <ModalDialog title="Rename this ad" onClose={() => setIsOpen(false)}>
          <label>
            Ad title
            <input />
          </label>
          <button type="button">Save title</button>
        </ModalDialog>
      ) : null}
    </>
  );
}

describe('ModalDialog', () => {
  it('opens named by its title, with focus inside it', async () => {
    render(<Opener />);
    await person.click(screen.getByRole('button', { name: 'Open it' }));
    const dialog = screen.getByRole('dialog', { name: 'Rename this ad' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it('keeps Tab inside the window, in both directions', async () => {
    render(<Opener />);
    await person.click(screen.getByRole('button', { name: 'Open it' }));
    const dialog = screen.getByRole('dialog');
    const focusOrder = [screen.getByRole('button', { name: 'Close' }), screen.getByLabelText('Ad title'), screen.getByRole('button', { name: 'Save title' })];

    focusOrder[2]?.focus();
    await person.tab();
    expect(document.activeElement).toBe(focusOrder[0]);
    await person.tab({ shift: true });
    expect(document.activeElement).toBe(focusOrder[2]);
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it('closes on Escape, on the Close button and on the backdrop, and returns focus to what opened it', async () => {
    render(<Opener />);
    const opener = screen.getByRole('button', { name: 'Open it' });
    for (const close of [() => person.keyboard('{Escape}'), () => person.click(screen.getByRole('button', { name: 'Close' })), () => person.click(document.querySelector('[aria-hidden="true"].absolute') as HTMLElement)]) {
      await person.click(opener);
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      await close();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(document.activeElement).toBe(opener);
    }
  });
});

describe('ConfirmDialog', () => {
  it('names the action on its button, and offers a way to back out', async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <ConfirmDialog title="Remove this ad?" confirmLabel="Remove ad" cancelLabel="Keep the ad" onConfirm={onConfirm} onClose={onClose}>
        It will disappear from your lists.
      </ConfirmDialog>,
    );
    expect(screen.getByText('It will disappear from your lists.')).toBeInTheDocument();
    await person.click(screen.getByRole('button', { name: 'Keep the ad' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    await person.click(screen.getByRole('button', { name: 'Remove ad' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('shows work in progress and stops a second press', async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog title="Remove this ad?" confirmLabel="Remove ad" isBusy onConfirm={onConfirm} onClose={() => undefined}>
        Sure?
      </ConfirmDialog>,
    );
    const busyButton = screen.getByRole('button', { name: 'Working…' });
    expect(busyButton).toBeDisabled();
    expect(busyButton).toHaveAttribute('aria-busy', 'true');
  });
});
