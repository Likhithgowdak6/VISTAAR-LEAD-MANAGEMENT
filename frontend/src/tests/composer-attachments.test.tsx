/**
 * Attaching something to a message.
 *
 * WHAT THESE ARE GUARDING. The composer is the one place in the app that can reach a customer,
 * and attachments give it three new ways to go wrong: sending the wrong thing, sending the same
 * thing twice, and breaking the plain-text send that every conversation depends on. So the
 * tests below are weighted towards those, not towards the menu looking right.
 *
 * The double-send test is the one that earned its place. The template writer in this codebase
 * already shipped a bug where three clicks produced two sends, because `sending` state is not
 * visible to a second handler in the same React batch. With an attachment the duplicate is an
 * upload as well as a message, so the guard is a ref and this proves it holds.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import MessageComposer from '../components/MessageComposer';

const uploaded = {
  objectKey: 'org/conv/abc.jpg',
  type: 'image' as const,
  mimeType: 'image/jpeg',
  fileName: 'venue.jpg',
  sizeBytes: 2048,
  isVoiceNote: false,
};

const photo = () => new File(['pretend-jpeg-bytes'], 'venue.jpg', { type: 'image/jpeg' });

const setup = (overrides: Record<string, unknown> = {}) => {
  const onSend = vi.fn().mockResolvedValue(undefined);
  const onUploadMedia = vi.fn().mockResolvedValue(uploaded);

  render(<MessageComposer onSend={onSend} onUploadMedia={onUploadMedia} {...overrides} />);

  return { onSend, onUploadMedia };
};

const attachPhoto = (file = photo()) => {
  fireEvent.click(screen.getByRole('button', { name: /add attachment/i }));
  fireEvent.click(screen.getByRole('menuitem', { name: /photo or video/i }));
  fireEvent.change(screen.getByTestId('photo-input'), { target: { files: [file] } });
};

describe('the attachment menu', () => {
  it('offers photo, document and voice', () => {
    setup();

    fireEvent.click(screen.getByRole('button', { name: /add attachment/i }));

    expect(screen.getByRole('menuitem', { name: /photo or video/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /document/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /voice message/i })).toBeInTheDocument();
  });

  it('is not rendered at all when attachments are unavailable', () => {
    // No upload handler means this deployment cannot store files; a button that always errors
    // is worse than no button.
    render(<MessageComposer onSend={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /add attachment/i })).not.toBeInTheDocument();
  });

  it('closes after a choice is made', () => {
    setup();
    attachPhoto();

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('offers only types the server will accept', () => {
    // The owner finds out a .heic will not send while the file dialog is open, rather than
    // after uploading four megabytes of it.
    setup();

    expect(screen.getByTestId('photo-input').getAttribute('accept')).toContain('image/jpeg');
    expect(screen.getByTestId('photo-input').getAttribute('accept')).not.toContain('image/heic');
    expect(screen.getByTestId('document-input').getAttribute('accept')).toContain('application/pdf');
  });
});

describe('a staged attachment', () => {
  it('shows the filename and size before anything is sent', () => {
    setup();
    attachPhoto();

    const staged = screen.getByTestId('staged-attachment');
    expect(staged).toHaveTextContent('venue.jpg');
    expect(staged).toHaveTextContent(/B|KB/);
  });

  it('can be removed again', () => {
    setup();
    attachPhoto();

    fireEvent.click(screen.getByRole('button', { name: /remove attachment/i }));

    expect(screen.queryByTestId('staged-attachment')).not.toBeInTheDocument();
  });

  it('is replaced, not added to, when a second file is picked', () => {
    // One attachment per message. A second pick that silently queued both would send a file
    // the owner thought they had swapped out.
    setup();
    attachPhoto();
    attachPhoto(new File(['other'], 'floorplan.pdf', { type: 'application/pdf' }));

    expect(screen.getAllByTestId('staged-attachment')).toHaveLength(1);
    expect(screen.getByTestId('staged-attachment')).toHaveTextContent('floorplan.pdf');
  });

  it('refuses an oversized file before uploading it', async () => {
    const { onUploadMedia } = setup();
    const huge = new File(['x'], 'wedding-film.mp4', { type: 'video/mp4' });
    Object.defineProperty(huge, 'size', { value: 40 * 1024 * 1024 });

    attachPhoto(huge);

    expect(await screen.findByRole('alert')).toHaveTextContent(/too large/i);
    expect(screen.queryByTestId('staged-attachment')).not.toBeInTheDocument();
    expect(onUploadMedia).not.toHaveBeenCalled();
  });

  it('enables Send with no text at all', () => {
    // An attachment can travel without a caption, so the usual "needs text" rule must relax.
    setup();

    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    attachPhoto();
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });
});

describe('sending', () => {
  it('uploads first, then sends the key it got back', async () => {
    const { onSend, onUploadMedia } = setup();
    attachPhoto();

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));

    expect(onUploadMedia).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: 'venue.jpg', kind: 'file' }),
    );
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ media: uploaded }));
  });

  it('sends the typed caption along with the file', async () => {
    const { onSend } = setup();
    attachPhoto();
    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: 'The hall at golden hour' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith(
        expect.objectContaining({ body: 'The hall at golden hour', media: uploaded }),
      ),
    );
  });

  it('DOES NOT SEND TWICE when Send is double-clicked', async () => {
    let resolveUpload: ((value: unknown) => void) | undefined;
    const onSend = vi.fn().mockResolvedValue(undefined);
    const onUploadMedia = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveUpload = resolve;
        }),
    );

    render(<MessageComposer onSend={onSend} onUploadMedia={onUploadMedia as never} />);
    attachPhoto();

    const sendButton = screen.getByRole('button', { name: 'Send' });
    fireEvent.click(sendButton);
    fireEvent.click(sendButton);
    fireEvent.click(sendButton);

    resolveUpload?.(uploaded);

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    // One upload too: the duplicate would be a second copy of the file on the server as well
    // as a second message to the customer.
    expect(onUploadMedia).toHaveBeenCalledTimes(1);
  });

  it('clears the attachment once the message is away', async () => {
    const { onSend } = setup();
    attachPhoto();

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(onSend).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('staged-attachment')).not.toBeInTheDocument());
  });

  it('KEEPS the attachment when the upload fails, so it can be retried', async () => {
    // Losing the file on failure would mean finding it again, which on a phone is the worst
    // part of the whole flow.
    const onUploadMedia = vi.fn().mockRejectedValue(new Error('Network down'));
    render(<MessageComposer onSend={vi.fn()} onUploadMedia={onUploadMedia} />);
    attachPhoto();

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Network down');
    expect(screen.getByTestId('staged-attachment')).toBeInTheDocument();
  });

  it('does not send a message when the upload fails', async () => {
    const onSend = vi.fn();
    render(
      <MessageComposer
        onSend={onSend}
        onUploadMedia={vi.fn().mockRejectedValue(new Error('nope'))}
      />,
    );
    attachPhoto();

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await screen.findByRole('alert');
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('what must not have changed', () => {
  it('still sends a plain text message with no media key', async () => {
    const { onSend, onUploadMedia } = setup();

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hello there' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));

    expect(onUploadMedia).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Hello there', media: null }),
    );
  });

  it('still refuses to send an empty message', () => {
    setup();

    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('still offers the message templates trigger alongside the attachment button', () => {
    setup({ canUseTemplates: true, onOpenTemplates: vi.fn() });

    expect(screen.getByRole('button', { name: /message templates/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add attachment/i })).toBeInTheDocument();
  });

  it('still inserts a saved quote into the box', () => {
    setup({ templates: [{ id: 't1', title: 'Wedding', body: 'Our wedding package starts at…' }] });

    fireEvent.change(screen.getByLabelText('Insert a template'), { target: { value: 't1' } });

    expect(screen.getByLabelText('Message')).toHaveValue('Our wedding package starts at…');
  });
});
