import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import LeadPanel from '../components/lead/LeadPanel';
import * as endpointsApi from '../api/endpoints';
import { PERMISSIONS } from '../lib/permissions';
import { AUTH_PAYLOAD, renderAuthed } from './lead-helpers';

// Tests may use `any` for Vitest mocks of untyped endpoint modules.
const endpoints = endpointsApi as any;

vi.mock('../api/endpoints');

const conversation = {
  id: 'c1',
  displayName: 'Riya Sharma',
  leadId: 'LEAD-1',
  stage: 'new',
  tags: [],
  assignedTo: null,
};

const withAllPermissions = () =>
  endpoints.refresh.mockResolvedValue(
    AUTH_PAYLOAD({
      role: 'admin',
      permissions: [
        PERMISSIONS.CRM_TAGS_MANAGE,
        PERMISSIONS.CRM_TASKS_MANAGE,
        PERMISSIONS.CRM_STAGE_MANAGE,
        PERMISSIONS.CLIENT_PII_REVEAL,
        PERMISSIONS.CONVERSATIONS_READ_ALL,
        PERMISSIONS.CONVERSATIONS_ASSIGN,
      ],
    }),
  );

beforeEach(() => {
  withAllPermissions();
  endpoints.listNotes.mockResolvedValue({ data: [] });
  endpoints.listTags.mockResolvedValue({ data: [] });
  endpoints.listConversationFollowUps.mockResolvedValue({ data: [] });
  endpoints.getActivity.mockResolvedValue({ data: [] });
  endpoints.listUsers.mockResolvedValue({
    data: [
      { id: 'u1', name: 'Asha Menon' },
      { id: 'u2', name: 'Vikram Rao' },
    ],
  });
  endpoints.listStages.mockResolvedValue({ data: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('LeadPanel — stage + reveal', () => {
  it('changes the stage through the API and calls onStageChange', async () => {
    endpoints.changeStage.mockResolvedValue({ data: { ...conversation, stage: 'qualified' } });
    const onStageChange = vi.fn();

    renderAuthed(
      <LeadPanel conversation={conversation} contactId="ct1" onStageChange={onStageChange} />,
    );

    const select = await screen.findByLabelText('Stage');
    fireEvent.change(select, { target: { value: 'qualified' } });

    await waitFor(() =>
      expect(endpoints.changeStage).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'c1', stage: 'qualified' }),
      ),
    );
    expect(onStageChange).toHaveBeenCalledWith('qualified');
  });

  it('reveals the phone only after the audited call and never renders it before', async () => {
    endpoints.revealPhone.mockResolvedValue({
      data: { contactId: 'ct1', leadId: 'LEAD-1', phone: '919876500123' },
    });

    const { container } = renderAuthed(
      <LeadPanel conversation={conversation} contactId="ct1" onStageChange={vi.fn()} />,
    );

    const revealButton = await screen.findByRole('button', { name: 'Reveal phone' });
    expect(container.innerHTML).not.toContain('919876500123');

    fireEvent.click(revealButton);

    expect(await screen.findByText('919876500123')).toBeInTheDocument();
    expect(screen.getByText(/audited/i)).toBeInTheDocument();
  });

  it('toggles the phone back off and re-shows it without a second audited call', async () => {
    endpoints.revealPhone.mockResolvedValue({
      data: { contactId: 'ct1', leadId: 'LEAD-1', phone: '919876500123' },
    });

    renderAuthed(<LeadPanel conversation={conversation} contactId="ct1" onStageChange={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Reveal phone' }));
    expect(await screen.findByText('919876500123')).toBeInTheDocument();

    // Hide it again.
    fireEvent.click(screen.getByRole('button', { name: 'Hide phone' }));
    expect(screen.queryByText('919876500123')).not.toBeInTheDocument();

    // Re-showing is local only — the number already left the backend, so no new reveal call.
    fireEvent.click(screen.getByRole('button', { name: 'Reveal phone' }));
    expect(await screen.findByText('919876500123')).toBeInTheDocument();
    expect(endpoints.revealPhone).toHaveBeenCalledTimes(1);
  });

  it('says so when there is no phone on file, and does not re-audit on further clicks', async () => {
    // @lid senders carry no phone, so the reveal endpoint answers with null.
    endpoints.revealPhone.mockResolvedValue({
      data: { contactId: 'ct1', leadId: 'LEAD-1', phone: null },
    });

    renderAuthed(<LeadPanel conversation={conversation} contactId="ct1" onStageChange={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Reveal phone' }));

    expect(await screen.findByText('No phone on file')).toBeInTheDocument();
    expect(screen.queryByText(/access is audited/i)).not.toBeInTheDocument();

    // Toggling stays local: a missing number must not spam the audit log.
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.queryByText('No phone on file')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reveal phone' }));
    expect(await screen.findByText('No phone on file')).toBeInTheDocument();
    expect(endpoints.revealPhone).toHaveBeenCalledTimes(1);
  });

  it('hides the reveal button without client_pii.reveal', async () => {
    endpoints.refresh.mockResolvedValue(
      AUTH_PAYLOAD({ role: 'staff', permissions: [PERMISSIONS.CRM_TASKS_MANAGE] }),
    );

    renderAuthed(<LeadPanel conversation={conversation} contactId="ct1" onStageChange={vi.fn()} />);

    await screen.findByText('Notes');
    expect(screen.queryByRole('button', { name: 'Reveal phone' })).not.toBeInTheDocument();
  });
});

describe('LeadPanel — stage can be applied by anyone with access', () => {
  it('lets a staff member change the stage — applying a stage is not admin-only', async () => {
    endpoints.refresh.mockResolvedValue(
      AUTH_PAYLOAD({
        role: 'staff',
        permissions: [
          PERMISSIONS.CRM_TASKS_MANAGE,
          (PERMISSIONS as any).CONVERSATIONS_READ_ASSIGNED,
        ],
      }),
    );
    endpoints.changeStage.mockResolvedValue({ data: { ...conversation, stage: 'won' } });

    renderAuthed(<LeadPanel conversation={conversation} contactId="ct1" onStageChange={vi.fn()} />);

    const select = await screen.findByLabelText('Stage');
    fireEvent.change(select, { target: { value: 'won' } });

    await waitFor(() =>
      expect(endpoints.changeStage).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'c1', stage: 'won' }),
      ),
    );
  });

  it('includes an admin-created custom stage as a pickable option', async () => {
    endpoints.listStages.mockResolvedValue({
      data: [{ key: 'hot-lead', label: 'Hot Lead', color: '#ff8800', status: 'active' }],
    });

    renderAuthed(<LeadPanel conversation={conversation} contactId="ct1" onStageChange={vi.fn()} />);

    await screen.findByLabelText('Stage');
    expect(await screen.findByRole('option', { name: 'Hot Lead' })).toBeInTheDocument();
  });
});

describe('LeadPanel — assignment', () => {
  it('lists team members and assigns the conversation through the API', async () => {
    endpoints.assignConversation.mockResolvedValue({ data: { assignedTo: 'u2' } });
    const onStageChange = vi.fn();

    renderAuthed(
      <LeadPanel conversation={conversation} contactId="ct1" onStageChange={onStageChange} />,
    );

    const select = await screen.findByLabelText('Assigned to');
    // The member list loads asynchronously after the select itself renders.
    await screen.findByRole('option', { name: 'Asha Menon' });
    expect(screen.getByRole('option', { name: 'Vikram Rao' })).toBeInTheDocument();

    fireEvent.change(select, { target: { value: 'u2' } });

    await waitFor(() =>
      expect(endpoints.assignConversation).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'c1', assignedTo: 'u2' }),
      ),
    );
    expect((select as HTMLSelectElement | HTMLInputElement).value).toBe('u2');
  });

  it('unassigns by sending assignedTo: null', async () => {
    endpoints.assignConversation.mockResolvedValue({ data: { assignedTo: null } });

    renderAuthed(
      <LeadPanel
        conversation={{ ...conversation, assignedTo: 'u1' }}
        contactId="ct1"
        onStageChange={vi.fn()}
      />,
    );

    const select = await screen.findByLabelText('Assigned to');
    // Wait for the member options to load — until then there's no <option value="u1">
    // for the select to match, so its reported value briefly falls back to ''.
    await screen.findByRole('option', { name: 'Asha Menon' });
    expect((select as HTMLSelectElement | HTMLInputElement).value).toBe('u1');

    fireEvent.change(select, { target: { value: '' } });

    await waitFor(() =>
      expect(endpoints.assignConversation).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'c1', assignedTo: null }),
      ),
    );
  });

  it('hides the assignment control without conversations.assign', async () => {
    endpoints.refresh.mockResolvedValue(
      AUTH_PAYLOAD({
        role: 'staff',
        permissions: [
          PERMISSIONS.CRM_TASKS_MANAGE,
          (PERMISSIONS as any).CONVERSATIONS_READ_ASSIGNED,
        ],
      }),
    );

    renderAuthed(<LeadPanel conversation={conversation} contactId="ct1" onStageChange={vi.fn()} />);

    await screen.findByText('Notes');
    expect(screen.queryByLabelText('Assigned to')).not.toBeInTheDocument();
    expect(endpoints.listUsers).not.toHaveBeenCalled();
  });
});

describe('LeadPanel — the event date', () => {
  /** The backend stores a day-only value at UTC midnight; the panel reads it back in UTC. */
  const utcMidnightInDays = (days: number) => {
    const today = new Date();

    return new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + days),
    ).toISOString();
  };

  it('shows the event date and how many days are left', async () => {
    renderAuthed(
      <LeadPanel
        conversation={{ ...conversation, eventDate: '2026-09-12T00:00:00.000Z' }}
        contactId="ct1"
        onStageChange={vi.fn()}
      />,
    );

    expect(await screen.findByText('Event date')).toBeInTheDocument();
    expect(screen.getByText('12 Sep 2026')).toBeInTheDocument();
  });

  it('counts the days down to an event that is still ahead', async () => {
    renderAuthed(
      <LeadPanel
        conversation={{ ...conversation, eventDate: utcMidnightInDays(12) }}
        contactId="ct1"
        onStageChange={vi.fn()}
      />,
    );

    expect(await screen.findByText('In 12 days')).toBeInTheDocument();
  });

  it('says "Tomorrow" and "Today" rather than counting to one and zero', async () => {
    const { unmount } = renderAuthed(
      <LeadPanel
        conversation={{ ...conversation, eventDate: utcMidnightInDays(1) }}
        contactId="ct1"
        onStageChange={vi.fn()}
      />,
    );
    expect(await screen.findByText('Tomorrow')).toBeInTheDocument();
    unmount();

    renderAuthed(
      <LeadPanel
        conversation={{ ...conversation, eventDate: utcMidnightInDays(0) }}
        contactId="ct1"
        onStageChange={vi.fn()}
      />,
    );
    expect(await screen.findByText('Today')).toBeInTheDocument();
  });

  it('says an event has passed rather than counting backwards silently', async () => {
    renderAuthed(
      <LeadPanel
        conversation={{ ...conversation, eventDate: utcMidnightInDays(-3) }}
        contactId="ct1"
        onStageChange={vi.fn()}
      />,
    );

    expect(await screen.findByText('Passed 3 days ago')).toBeInTheDocument();
  });

  it('renders nothing at all for a lead who has not given a date yet', async () => {
    renderAuthed(<LeadPanel conversation={conversation} contactId="ct1" onStageChange={vi.fn()} />);

    await screen.findByText('Notes');
    expect(screen.queryByText('Event date')).not.toBeInTheDocument();
  });
});

describe('LeadPanel — the lead score', () => {
  it('shows the band, the score and which signals fired', async () => {
    renderAuthed(
      <LeadPanel
        conversation={{
          ...conversation,
          leadScore: 85,
          leadScoreBand: 'hot',
          leadScoreSignals: ['event_date', 'venue', 'budget', 'quotation_requested', 'replied'],
        }}
        contactId="ct1"
        onStageChange={vi.fn()}
      />,
    );

    expect(await screen.findByText('Lead score')).toBeInTheDocument();
    expect(screen.getByText('Hot · 85')).toBeInTheDocument();
    expect(screen.getByText('Call this one yourself')).toBeInTheDocument();
    expect(screen.getByText(/Asked for a quotation/).textContent).toContain('✓');
  });

  it('shows the missing signals too - they are what to ask next', async () => {
    renderAuthed(
      <LeadPanel
        conversation={{ ...conversation, leadScore: 20, leadScoreBand: 'cold', leadScoreSignals: ['event_date'] }}
        contactId="ct1"
        onStageChange={vi.fn()}
      />,
    );

    expect(await screen.findByText(/Budget given/)).toBeInTheDocument();
    expect(screen.getByText(/Asked about availability/).textContent).toContain('○');
  });

  it('renders a zero for a lead nobody has scored yet', async () => {
    renderAuthed(<LeadPanel conversation={conversation} contactId="ct1" onStageChange={vi.fn()} />);

    expect(await screen.findByText('Lead score')).toBeInTheDocument();
    expect(screen.getByText('Long-term nurture')).toBeInTheDocument();
  });
});
