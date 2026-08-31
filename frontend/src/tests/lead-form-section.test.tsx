import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as endpointsApi from '../api/endpoints';
import LeadFormSection from '../components/lead/LeadFormSection';
import { AUTH_PAYLOAD, renderAuthed } from './lead-helpers';

// Tests may use `any` for Vitest mocks of untyped endpoint modules.
const endpoints = endpointsApi as any;

vi.mock('../api/endpoints');

const SUBMISSION = {
  id: 'sub-1',
  status: 'imported',
  skipReason: null,
  submittedAt: '2026-08-19T02:32:03.000Z',
  platform: 'ig',
  isOrganic: false,
  leadStatus: 'CREATED',
  campaignName: '[02] VM - New - Leads',
  adName: 'Test - wedding',
  adsetName: '[29] One-day event',
  formName: 'wedding/Birthday Aug 2026',
  fields: [
    { key: 'how_would_you_describe_this_event?', label: 'How would you describe this event?', value: '2-3 days wedding' },
    { key: 'event_dates_?', label: 'Event dates ?', value: '1st week of October' },
  ],
  hasEmail: true,
  hasPhone: true,
};

beforeEach(() => {
  endpoints.refresh.mockResolvedValue(AUTH_PAYLOAD({ role: 'staff', permissions: [] }));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('LeadFormSection', () => {
  it('shows the form answers with their campaign and platform', async () => {
    endpoints.getLeadSubmissions.mockResolvedValue({ data: [SUBMISSION] });

    renderAuthed(<LeadFormSection conversationId="c1" />);

    expect(await screen.findByText('How would you describe this event?')).toBeInTheDocument();
    expect(screen.getByText('2-3 days wedding')).toBeInTheDocument();
    expect(screen.getByText('1st week of October')).toBeInTheDocument();
    expect(screen.getByText('Instagram')).toBeInTheDocument();
    expect(screen.getByText('[02] VM - New - Leads')).toBeInTheDocument();
  });

  it('renders nothing for a lead that never came through a form', async () => {
    endpoints.getLeadSubmissions.mockResolvedValue({ data: [] });

    const { container } = renderAuthed(<LeadFormSection conversationId="c1" />);

    await waitFor(() => expect(endpoints.getLeadSubmissions).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('section')).toBeNull());
  });

  it('collapses earlier submissions behind a toggle', async () => {
    endpoints.getLeadSubmissions.mockResolvedValue({
      data: [
        SUBMISSION,
        {
          ...SUBMISSION,
          id: 'sub-0',
          fields: [{ key: 'event_dates_?', label: 'Event dates ?', value: 'Last December' }],
        },
      ],
    });

    renderAuthed(<LeadFormSection conversationId="c1" />);

    expect(await screen.findByText('1st week of October')).toBeInTheDocument();
    expect(screen.queryByText('Last December')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Show 1 earlier submission' }),
    ).toBeInTheDocument();
  });
});
