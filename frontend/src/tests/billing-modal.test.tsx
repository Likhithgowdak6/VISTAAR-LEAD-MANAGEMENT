import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ConfirmDialog from '../components/ConfirmDialog';

vi.mock('../hooks/useMobileBackLayer', () => ({ useMobileBackLayer: () => undefined }));

describe('billing dialog keyboard access', () => {
  it('moves focus into the modal, wraps Tab in both directions, and restores the opener', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const { unmount } = render(<ConfirmDialog title="Reverse payment?" message="Synthetic test"
      onCancel={vi.fn()} onConfirm={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Reverse payment?' });
    const first = screen.getByRole('button', { name: 'Go back' });
    const last = screen.getByRole('button', { name: 'Confirm' });
    expect(dialog).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(first).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(first).toHaveFocus();
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it('Escape closes only the topmost dialog', () => {
    const parentClose = vi.fn();
    const childClose = vi.fn();
    render(<>
      <ConfirmDialog title="Parent" message="Synthetic parent" onCancel={parentClose} onConfirm={vi.fn()} />
      <ConfirmDialog title="Child" message="Synthetic child" onCancel={childClose} onConfirm={vi.fn()} />
    </>);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(childClose).toHaveBeenCalledOnce();
    expect(parentClose).not.toHaveBeenCalled();
  });

  it('does not dismiss an in-flight financial action with Escape', () => {
    const close = vi.fn();
    render(<ConfirmDialog title="Working" message="Synthetic test" busy onCancel={close} onConfirm={vi.fn()} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
  });
});
