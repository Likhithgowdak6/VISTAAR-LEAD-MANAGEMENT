import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AiAutomationSection from '../components/lead/AiAutomationSection';
import * as endpointsApi from '../api/endpoints';
import { PERMISSIONS } from '../lib/permissions';
import { AUTH_PAYLOAD, renderAuthed } from './lead-helpers';

// Tests may use `any` for Vitest mocks of untyped endpoint modules.
const endpoints = endpointsApi as any;

vi.mock('../api/endpoints');

beforeEach(() => {
  endpoints.getAiApproval.mockResolvedValue({ data: null });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('AiAutomationSection — automation toggle', () => {
  it('shows a checkbox and toggles automation for someone who can manage it', async () => {
    endpoints.refresh.mockResolvedValue(
      AUTH_PAYLOAD({ role: 'admin', permissions: [PERMISSIONS.AI_AUTOMATION_MANAGE] }),
    );
    endpoints.setAiAutomation.mockResolvedValue({
      data: { aiAutomationEnabled: true, aiAutomationPausedReason: null },
    });

    renderAuthed(
      <AiAutomationSection
        conversationId="c1"
        aiAutomationEnabled={false}
        aiAutomationPausedReason={null}
      />,
    );

    const checkbox = await screen.findByLabelText('Auto-qualify');
    expect((checkbox as HTMLInputElement).checked).toBe(false);

    fireEvent.click(checkbox);

    await waitFor(() =>
      expect(endpoints.setAiAutomation).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'c1', enabled: true }),
      ),
    );
    await waitFor(() => expect((checkbox as HTMLInputElement).checked).toBe(true));
  });

  it('shows a read-only status without manage permission', async () => {
    endpoints.refresh.mockResolvedValue(AUTH_PAYLOAD({ role: 'staff', permissions: [] }));

    renderAuthed(
      <AiAutomationSection
        conversationId="c1"
        aiAutomationEnabled={true}
        aiAutomationPausedReason={null}
      />,
    );

    await screen.findByText('AI assistant');
    expect(screen.queryByLabelText('Auto-qualify')).not.toBeInTheDocument();
    expect(screen.getByText('On')).toBeInTheDocument();
  });

  it('shows the paused reason when automation was escalated off', async () => {
    endpoints.refresh.mockResolvedValue(AUTH_PAYLOAD({ role: 'staff', permissions: [] }));

    renderAuthed(
      <AiAutomationSection
        conversationId="c1"
        aiAutomationEnabled={false}
        aiAutomationPausedReason="Lead asked for a human."
      />,
    );

    expect(await screen.findByText(/Lead asked for a human\./)).toBeInTheDocument();
  });
});

describe('AiAutomationSection — opted-out lead', () => {
  it('shows the opt-out state, distinctly from an ordinary pause', async () => {
    endpoints.refresh.mockResolvedValue(
      AUTH_PAYLOAD({ role: 'admin', permissions: [PERMISSIONS.AI_AUTOMATION_MANAGE] }),
    );

    renderAuthed(
      <AiAutomationSection
        conversationId="c1"
        aiAutomationEnabled={false}
        aiAutomationPausedReason="This lead asked to stop receiving messages."
        optedOutAt="2026-08-24T09:00:00.000Z"
      />,
    );

    expect(await screen.findByText(/This lead asked to stop/)).toBeInTheDocument();
    expect(screen.getByText(/Off — opted out/)).toBeInTheDocument();
    expect(screen.getByText(/will ever go to them again/)).toBeInTheDocument();
  });

  it('does not offer the ordinary toggle, so nobody can silently re-enable them', async () => {
    endpoints.refresh.mockResolvedValue(
      AUTH_PAYLOAD({ role: 'admin', permissions: [PERMISSIONS.AI_AUTOMATION_MANAGE] }),
    );

    renderAuthed(
      <AiAutomationSection
        conversationId="c1"
        aiAutomationEnabled={false}
        aiAutomationPausedReason="This lead asked to stop receiving messages."
        optedOutAt="2026-08-24T09:00:00.000Z"
      />,
    );

    await screen.findByText(/Off — opted out/);
    expect(screen.queryByLabelText('Auto-qualify')).not.toBeInTheDocument();
    expect(endpoints.setAiAutomation).not.toHaveBeenCalled();
  });

  it('still shows the ordinary toggle for a lead who never opted out', async () => {
    endpoints.refresh.mockResolvedValue(
      AUTH_PAYLOAD({ role: 'admin', permissions: [PERMISSIONS.AI_AUTOMATION_MANAGE] }),
    );

    renderAuthed(
      <AiAutomationSection
        conversationId="c1"
        aiAutomationEnabled={false}
        aiAutomationPausedReason={null}
        optedOutAt={null}
      />,
    );

    expect(await screen.findByLabelText('Auto-qualify')).toBeInTheDocument();
    expect(screen.queryByText(/Off — opted out/)).not.toBeInTheDocument();
  });
});

describe('AiAutomationSection — pending draft review', () => {
  it('loads a pending draft and approves it', async () => {
    endpoints.refresh.mockResolvedValue(
      AUTH_PAYLOAD({ role: 'staff', permissions: [PERMISSIONS.MESSAGES_SEND] }),
    );
    endpoints.getAiApproval.mockResolvedValue({
      data: { id: 'a1', draft: 'Here is our quote...', status: 'pending' },
    });
    endpoints.resolveAiApproval.mockResolvedValue({
      data: { approval: { id: 'a1', status: 'resolved' }, sent: true },
    });

    renderAuthed(
      <AiAutomationSection
        conversationId="c1"
        aiAutomationEnabled={true}
        aiAutomationPausedReason={null}
      />,
    );

    expect(await screen.findByText('Here is our quote...')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Approve & send' }));

    await waitFor(() =>
      expect(endpoints.resolveAiApproval).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'c1', verdict: 'approve' }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText('Here is our quote...')).not.toBeInTheDocument(),
    );
  });

  it('sends a revise instruction with verdict "edit" and keeps the card open for the new draft', async () => {
    endpoints.refresh.mockResolvedValue(
      AUTH_PAYLOAD({ role: 'staff', permissions: [PERMISSIONS.MESSAGES_SEND] }),
    );
    endpoints.getAiApproval.mockResolvedValue({
      data: { id: 'a1', draft: 'Original draft', status: 'pending' },
    });
    endpoints.resolveAiApproval.mockResolvedValue({
      data: { approval: { id: 'a1', draft: 'Shorter draft', status: 'pending' }, sent: false },
    });

    renderAuthed(
      <AiAutomationSection
        conversationId="c1"
        aiAutomationEnabled={true}
        aiAutomationPausedReason={null}
      />,
    );

    await screen.findByText('Original draft');
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI to revise' }));

    const textarea = await screen.findByPlaceholderText('e.g. mention the festive discount');
    fireEvent.change(textarea, { target: { value: 'make it shorter' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send instruction' }));

    await waitFor(() =>
      expect(endpoints.resolveAiApproval).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'c1', verdict: 'edit', instruction: 'make it shorter' }),
      ),
    );
    expect(await screen.findByText('Shorter draft')).toBeInTheDocument();
  });

  it('does not show approve/skip actions without messages.send', async () => {
    endpoints.refresh.mockResolvedValue(AUTH_PAYLOAD({ role: 'staff', permissions: [] }));
    endpoints.getAiApproval.mockResolvedValue({
      data: { id: 'a1', draft: 'Here is our quote...', status: 'pending' },
    });

    renderAuthed(
      <AiAutomationSection
        conversationId="c1"
        aiAutomationEnabled={true}
        aiAutomationPausedReason={null}
      />,
    );

    await screen.findByText('Here is our quote...');
    expect(screen.queryByRole('button', { name: 'Approve & send' })).not.toBeInTheDocument();
  });
});
