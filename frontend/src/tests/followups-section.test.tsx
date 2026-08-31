import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import FollowUpsSection from '../components/lead/FollowUpsSection';
import * as endpointsApi from '../api/endpoints';
import { PERMISSIONS } from '../lib/permissions';
import { AUTH_PAYLOAD, renderAuthed } from './lead-helpers';

// Tests may use `any` for Vitest mocks of untyped endpoint modules.
const endpoints = endpointsApi as any;

vi.mock('../api/endpoints');

afterEach(() => {
  vi.clearAllMocks();
});

describe('FollowUpsSection', () => {
  it('creates a follow-up and completes a pending one', async () => {
    endpoints.refresh.mockResolvedValue(
      AUTH_PAYLOAD({ role: 'admin', permissions: [PERMISSIONS.CRM_TASKS_MANAGE] }),
    );
    const pending = {
      id: 'f1',
      type: 'call',
      priority: 'high',
      status: 'pending',
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      note: 'Call back',
    };
    endpoints.listConversationFollowUps
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [pending] })
      .mockResolvedValueOnce({ data: [{ ...pending, status: 'completed' }] });
    endpoints.createFollowUp.mockResolvedValue({ data: pending });
    endpoints.completeFollowUp.mockResolvedValue({ data: { ...pending, status: 'completed' } });

    renderAuthed(<FollowUpsSection conversationId="c1" />);

    const dueInput = await screen.findByLabelText('Follow-up due date');
    fireEvent.change(dueInput, { target: { value: '2026-08-01T10:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add follow-up' }));

    await waitFor(() =>
      expect(endpoints.createFollowUp).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'c1', type: 'call', priority: 'normal' }),
      ),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Complete' }));

    await waitFor(() =>
      expect(endpoints.completeFollowUp).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 'f1' }),
      ),
    );
  });

  it('renders nothing without crm.tasks.manage', async () => {
    endpoints.refresh.mockResolvedValue(AUTH_PAYLOAD({ role: 'staff', permissions: [] }));

    const { container } = renderAuthed(<FollowUpsSection conversationId="c1" />);

    // Give the provider a tick to bootstrap; the section renders null regardless.
    await waitFor(() => expect(endpoints.refresh).toHaveBeenCalled());
    expect(container.querySelector('form')).toBeNull();
    expect(endpoints.listConversationFollowUps).not.toHaveBeenCalled();
  });
});
