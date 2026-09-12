import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as endpointsApi from '../api/endpoints';
import { PERMISSIONS } from '../lib/permissions';
import AiKnowledgePage from '../pages/AiKnowledgePage';
import { AUTH_PAYLOAD, renderAuthed } from './lead-helpers';

// Tests may use `any` for Vitest mocks of untyped endpoint modules.
const endpoints = endpointsApi as any;

vi.mock('../api/endpoints');

const KNOWLEDGE = [
  {
    id: 'k1',
    label: 'Warranty policy',
    content: 'Warranty is two years.',
    category: 'policy',
    status: 'active',
  },
  {
    id: 'k2',
    label: 'Old pricing',
    content: 'Deprecated.',
    category: 'pricing',
    status: 'archived',
  },
];

beforeEach(() => {
  endpoints.listAiKnowledge.mockResolvedValue({ data: KNOWLEDGE });
});

afterEach(() => {
  vi.clearAllMocks();
});

const asAdmin = () =>
  endpoints.refresh.mockResolvedValue(
    AUTH_PAYLOAD({ role: 'admin', permissions: [PERMISSIONS.AI_KNOWLEDGE_MANAGE] }),
  );

describe('AiKnowledgePage', () => {
  it('lists knowledge entries with their category and status', async () => {
    asAdmin();
    renderAuthed(<AiKnowledgePage />);

    expect(await screen.findByText('Warranty policy')).toBeInTheDocument();
    expect(screen.getByText('Warranty is two years.')).toBeInTheDocument();
    expect(screen.getByText('Old pricing')).toBeInTheDocument();
    expect(screen.getByText('Archived')).toBeInTheDocument();
  });

  const openDialog = async () => {
    await screen.findByText('Warranty policy');
    fireEvent.click(screen.getByRole('button', { name: 'Tell the AI what to do' }));
    return screen.getByRole('dialog', { name: 'Tell the AI what to do' });
  };

  it('optimizes a rough note and saves the reviewed instruction', async () => {
    asAdmin();
    endpoints.optimizeAiKnowledge.mockResolvedValue({
      data: {
        label: 'Greeting a new customer',
        content: 'Always greet a customer on the first message of a new conversation.',
        category: 'rules',
        notes: 'Tightened it into one instruction with a trigger.',
        rawText: 'always greet the customer when u r chating with a new customer',
      },
    });
    endpoints.createAiKnowledge.mockResolvedValue({ data: { id: 'k3' } });
    renderAuthed(<AiKnowledgePage />);

    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByLabelText('Your instruction'), {
      target: { value: 'always greet the customer when u r chating with a new customer' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '✦ Optimize the prompt' }));

    await waitFor(() =>
      expect(endpoints.optimizeAiKnowledge).toHaveBeenCalledWith(
        expect.objectContaining({
          rawText: 'always greet the customer when u r chating with a new customer',
        }),
      ),
    );

    // The rewrite is a proposal: it lands in editable fields, with the model's note on what moved.
    expect(await screen.findByLabelText('Label')).toHaveValue('Greeting a new customer');
    expect(screen.getByLabelText('Fact or instruction')).toHaveValue(
      'Always greet a customer on the first message of a new conversation.',
    );
    // The category arrives decided, shown as a fact rather than as a question. No picker unless asked.
    expect(screen.getByText('Filed under')).toBeInTheDocument();
    expect(screen.queryByLabelText('Category')).not.toBeInTheDocument();
    expect(screen.getByText('Tightened it into one instruction with a trigger.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(endpoints.createAiKnowledge).toHaveBeenCalledWith(
        expect.objectContaining({
          label: 'Greeting a new customer',
          content: 'Always greet a customer on the first message of a new conversation.',
          category: 'rules',
        }),
      ),
    );
  });

  it('saves the note as written when the owner skips the rewrite', async () => {
    asAdmin();
    endpoints.createAiKnowledge.mockResolvedValue({ data: { id: 'k4' } });
    renderAuthed(<AiKnowledgePage />);

    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByLabelText('Your instruction'), {
      target: { value: 'Never quote a price without asking me first.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use my words' }));

    // Straight to review, no LLM call, his wording untouched.
    expect(endpoints.optimizeAiKnowledge).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Fact or instruction')).toHaveValue(
      'Never quote a price without asking me first.',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(endpoints.createAiKnowledge).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Never quote a price without asking me first.',
          category: 'rules',
        }),
      ),
    );
  });

  it('keeps the note editable when the optimize call fails', async () => {
    asAdmin();
    endpoints.optimizeAiKnowledge.mockRejectedValue(new Error('AI brain is off'));
    renderAuthed(<AiKnowledgePage />);

    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByLabelText('Your instruction'), {
      target: { value: 'Always confirm the shoot date twice.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '✦ Optimize the prompt' }));

    // The brain being unavailable must not read as "your note was rejected", and must not lose it.
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByLabelText('Your instruction')).toHaveValue(
      'Always confirm the shoot date twice.',
    );
    expect(screen.getByRole('button', { name: 'Use my words' })).toBeEnabled();
  });

  it('archives an active knowledge entry', async () => {
    asAdmin();
    endpoints.archiveAiKnowledge.mockResolvedValue({ data: {} });
    renderAuthed(<AiKnowledgePage />);

    await screen.findByText('Warranty policy');
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));

    await waitFor(() =>
      expect(endpoints.archiveAiKnowledge).toHaveBeenCalledWith(
        expect.objectContaining({ knowledgeId: 'k1' }),
      ),
    );
  });

  it('offers every category the API accepts, including the three that were unreachable', async () => {
    asAdmin();
    renderAuthed(<AiKnowledgePage />);

    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByLabelText('Your instruction'), {
      target: { value: 'We shoot across Karnataka.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use my words' }));

    // The picker is opt-in now, so reaching it is part of what this checks.
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));

    const options = Array.from(
      (screen.getByLabelText('Category') as HTMLSelectElement).options,
    ).map((option) => option.value);

    expect(options).toEqual([
      'company',
      'services',
      'pricing',
      'rules',
      'policy',
      'product',
      'faq',
      'other',
    ]);
  });

  it('edits an entry in place instead of forcing an archive-and-retype', async () => {
    asAdmin();
    endpoints.updateAiKnowledge.mockResolvedValue({ data: {} });
    renderAuthed(<AiKnowledgePage />);

    await screen.findByText('Warranty policy');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    // Scoped to the edit form: the add form above it has a "Fact" field of its own, and the
    // point of the seeded values is that a typo is a correction rather than a re-entry.
    const form = screen.getByRole('form', { name: 'Edit Warranty policy' });
    const fact = within(form).getByLabelText('Fact');
    expect(fact).toHaveValue('Warranty is two years.');

    fireEvent.change(fact, { target: { value: 'Warranty is three years.' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(endpoints.updateAiKnowledge).toHaveBeenCalledWith(
        expect.objectContaining({
          knowledgeId: 'k1',
          content: 'Warranty is three years.',
          category: 'policy',
        }),
      ),
    );
    expect(form).not.toBeInTheDocument();
  });

  it('does not offer Edit on an archived entry, but still offers Delete', async () => {
    asAdmin();
    endpoints.listAiKnowledge.mockResolvedValue({ data: [KNOWLEDGE[1]] });
    renderAuthed(<AiKnowledgePage />);

    await screen.findByText('Old pricing');
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
    // Clearing out archived entries is the main reason to delete one.
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('deletes an entry only after the confirm is accepted', async () => {
    asAdmin();
    endpoints.deleteAiKnowledge.mockResolvedValue({ data: {} });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderAuthed(<AiKnowledgePage />);

    await screen.findByText('Warranty policy');
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]);

    // Declining the confirm must leave the entry alone - this one cannot be undone.
    expect(confirm).toHaveBeenCalled();
    expect(endpoints.deleteAiKnowledge).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]);

    await waitFor(() =>
      expect(endpoints.deleteAiKnowledge).toHaveBeenCalledWith(
        expect.objectContaining({ knowledgeId: 'k1' }),
      ),
    );

    confirm.mockRestore();
  });

  it('hides management controls without ai.knowledge.manage', async () => {
    endpoints.refresh.mockResolvedValue(AUTH_PAYLOAD({ role: 'staff', permissions: [] }));

    renderAuthed(<AiKnowledgePage />);

    await screen.findByText('Warranty policy');
    expect(
      screen.queryByRole('button', { name: 'Tell the AI what to do' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });
});
