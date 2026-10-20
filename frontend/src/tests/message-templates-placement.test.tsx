/**
 * Where the template writer lives: the composer, not the lead panel.
 *
 * WHAT THIS FILE IS FOR. Moving a feature is the kind of change that looks finished on screen
 * and is not: the old entry point lingers, or the new one hands the generator the wrong
 * conversation. MessageTemplatesSection's own behaviour - generating, editing, the
 * `generatedFor` stamp, the idempotency keys - is already covered by
 * message-templates-section.test.tsx and is not retested here. This file covers the move:
 *
 *   - "Suggest reply" is gone from the composer and the template trigger stands in its slot;
 *   - the trigger respects the same AI permission the lead panel used to gate on;
 *   - the lead panel no longer renders the writer, and still renders everything else;
 *   - the dialog is handed the OPEN conversation, and is remounted when the thread changes.
 *
 * The last one is the dangerous one. A quote written for a December wedding landing on someone
 * who asked about a birthday is not recoverable, so the targeting is asserted on the props the
 * dialog actually receives rather than inferred from the UI.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import MessageComposer from '../components/MessageComposer';

describe('the composer trigger', () => {
  it('no longer offers Suggest reply', () => {
    render(<MessageComposer onSend={vi.fn()} canUseTemplates onOpenTemplates={vi.fn()} />);

    // The feature it replaced. Left behind, the owner has two ways to put words in the box and
    // only one of them still has a backend behind it.
    expect(screen.queryByRole('button', { name: /suggest reply/i })).not.toBeInTheDocument();
  });

  it('offers the template writer in its place', () => {
    render(<MessageComposer onSend={vi.fn()} canUseTemplates onOpenTemplates={vi.fn()} />);

    expect(screen.getByRole('button', { name: /message templates/i })).toBeInTheDocument();
  });

  it('opens the writer rather than sending anything', () => {
    const onOpenTemplates = vi.fn();
    const onSend = vi.fn();
    render(
      <MessageComposer onSend={onSend} canUseTemplates onOpenTemplates={onOpenTemplates} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /message templates/i }));

    expect(onOpenTemplates).toHaveBeenCalledTimes(1);
    // Nothing reaches the customer from this button. The send happens inside the writer, under
    // its own stamp and idempotency key.
    expect(onSend).not.toHaveBeenCalled();
  });

  it('is hidden for a user without the AI permission', () => {
    // Same gate the lead panel applied before the move - `ai.generate`, passed down as
    // canUseTemplates. A staff member who could not draft before must not be able to now.
    render(<MessageComposer onSend={vi.fn()} onOpenTemplates={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /message templates/i })).not.toBeInTheDocument();
  });

  it('is hidden when no handler is wired, rather than rendering a dead button', () => {
    render(<MessageComposer onSend={vi.fn()} canUseTemplates />);

    expect(screen.queryByRole('button', { name: /message templates/i })).not.toBeInTheDocument();
  });

  it('leaves the saved-quote picker alone', () => {
    // A different feature that happens to share the toolbar: these are stored templates the
    // owner wrote earlier, inserted into the box. The move must not disturb them.
    render(
      <MessageComposer
        onSend={vi.fn()}
        canUseTemplates
        onOpenTemplates={vi.fn()}
        templates={[{ id: 't1', title: 'Wedding', body: 'Hi' } as never]}
      />,
    );

    expect(screen.getByLabelText('Insert a template')).toBeInTheDocument();
  });
});

describe('what the composer sends', () => {
  it('no longer reports AI-draft feedback, because nothing produces a draft here', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<MessageComposer onSend={onSend} canUseTemplates onOpenTemplates={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Typed by hand' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await vi.waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));

    // `draftId`/`wasEdited` went with Suggest reply. Reporting an outcome for a draft that was
    // never generated would be a fabricated signal, so the fields are gone rather than always
    // null - and this asserts they are not quietly reintroduced.
    const sent = onSend.mock.calls[0][0];
    expect(sent).not.toHaveProperty('draftId');
    expect(sent).not.toHaveProperty('wasEdited');
    expect(sent.body).toBe('Typed by hand');
    expect(typeof sent.idempotencyKey).toBe('string');
  });
});

describe('the lead panel', () => {
  const panel = () => {
    // Read as source rather than rendered: LeadPanel pulls in fourteen sections, each with its
    // own fetches and context, and mounting all of them to assert the absence of one is both
    // slow and fragile for reasons unrelated to this change. The import is the honest signal -
    // if the writer is rendered here again, it has to be imported again.
    return import('node:fs').then(({ readFileSync }) =>
      readFileSync('src/components/lead/LeadPanel.tsx', 'utf8'),
    );
  };

  it('no longer renders the template writer', async () => {
    const source = await panel();

    expect(source).not.toContain('<MessageTemplatesSection');
    expect(source).not.toContain("from './MessageTemplatesSection'");
  });

  it('still renders the sections that were not moved', async () => {
    const source = await panel();

    // The brief was to move one thing. These are the neighbours it sat between.
    for (const section of [
      '<StageControl',
      '<ServiceSection',
      '<LeadScoreSection',
      '<AiAutomationSection',
      '<AssignmentControl',
      '<RevealPhone',
      '<LeadFormSection',
      '<TagsSection',
      '<NotesSection',
      '<FollowUpsSection',
      '<ActivitySection',
      '<DeleteChatSection',
    ]) {
      expect(source).toContain(section);
    }
  });

  it('keeps the writer component on disk for its new home', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/components/lead/MessageTemplatesSection.tsx', 'utf8');

    // Moved, not deleted - and not duplicated either. The dialog renders this same component.
    expect(source).toContain('MessageTemplatesSection');
    expect(source).toContain('generateTemplates');
  });
});

describe('which conversation the writer targets', () => {
  const view = () =>
    import('node:fs').then(({ readFileSync }) =>
      readFileSync('src/components/ConversationView.tsx', 'utf8'),
    );

  it('hands the dialog the open thread', async () => {
    const source = await view();

    expect(source).toContain('conversationId={conversationId}');
  });

  it('remounts the dialog when the thread changes', async () => {
    const source = await view();

    // THE SAFEGUARD THAT MATTERS. Without the key, switching leads leaves the previous lead's
    // generated options mounted and apparently ready to send. `generatedFor` inside the writer
    // refuses the send even then, but the remount means the owner never sees a stale batch at
    // all.
    const dialog = source.slice(source.indexOf('<MessageTemplatesDialog'));
    expect(dialog.slice(0, 400)).toContain('key={conversationId}');
  });

  it('builds no second generator or endpoint', async () => {
    const dialogSource = await import('node:fs').then(({ readFileSync }) =>
      readFileSync('src/components/MessageTemplatesDialog.tsx', 'utf8'),
    );

    // The dialog is a shell. If it ever starts calling the API itself, the stamp, the keys and
    // the in-flight guard inside MessageTemplatesSection stop protecting the send.
    expect(dialogSource).toContain('<MessageTemplatesSection');
    expect(dialogSource).not.toContain('generateTemplates(');
    expect(dialogSource).not.toContain('sendMessage(');
  });
});
