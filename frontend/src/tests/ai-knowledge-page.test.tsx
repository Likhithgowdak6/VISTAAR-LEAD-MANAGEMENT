import { fireEvent, screen, waitFor } from '@testing-library/react';
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

  it('creates a new knowledge entry', async () => {
    asAdmin();
    endpoints.createAiKnowledge.mockResolvedValue({ data: { id: 'k3' } });
    renderAuthed(<AiKnowledgePage />);

    await screen.findByText('Warranty policy');

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Delivery' } });
    fireEvent.change(screen.getByLabelText('Fact'), {
      target: { value: 'Delivery takes 3-5 business days.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add fact' }));

    await waitFor(() =>
      expect(endpoints.createAiKnowledge).toHaveBeenCalledWith(
        expect.objectContaining({
          label: 'Delivery',
          content: 'Delivery takes 3-5 business days.',
        }),
      ),
    );
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

  it('hides management controls without ai.knowledge.manage', async () => {
    endpoints.refresh.mockResolvedValue(AUTH_PAYLOAD({ role: 'staff', permissions: [] }));

    renderAuthed(<AiKnowledgePage />);

    await screen.findByText('Warranty policy');
    expect(screen.queryByRole('button', { name: 'Add fact' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
  });
});
