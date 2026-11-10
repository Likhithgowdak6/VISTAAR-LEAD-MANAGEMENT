import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as endpointsApi from '../api/endpoints';
import { GoogleCalendarIntegrationCard } from '../components/google-calendar/GoogleCalendarIntegrationCard';
import { AUTH_PAYLOAD, renderAuthed } from './lead-helpers';

const endpoints = endpointsApi as any;

vi.mock('../api/endpoints', () => ({
  getGoogleCalendarStatus: vi.fn(),
  getGoogleCalendarAuthUrl: vi.fn(),
  updateGoogleCalendars: vi.fn(),
  syncGoogleCalendarNow: vi.fn(),
  disconnectGoogleCalendar: vi.fn(),
  listUncertainEvents: vi.fn(),
  confirmUncertainEvent: vi.fn(),
  refresh: vi.fn(),
}));

describe('GoogleCalendarIntegrationCard', () => {
  beforeEach(() => {
    endpoints.refresh.mockResolvedValue(AUTH_PAYLOAD());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders "Not Connected" state with connect button when no connection exists', async () => {
    endpoints.getGoogleCalendarStatus.mockResolvedValue({
      data: {
        connected: false,
        connection: null,
        calendars: [],
        uncertainCount: 0,
      },
    });

    renderAuthed(<GoogleCalendarIntegrationCard />);

    await waitFor(() => {
      expect(screen.getByText('Google Calendar Integration')).toBeInTheDocument();
      expect(screen.getByText('Not Connected')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Connect Google Calendar/i })).toBeInTheDocument();
    });
  });

  it('renders "Connected" state with account email, sync now, and disconnect buttons', async () => {
    endpoints.getGoogleCalendarStatus.mockResolvedValue({
      data: {
        connected: true,
        connection: {
          id: 'conn_1',
          accountEmail: 'photographer@studio.com',
          status: 'connected',
          defaultReminderMinutes: 15,
          customReminderMinutes: 120,
        },
        calendars: [
          {
            id: 'cal_1',
            calendarId: 'primary',
            summary: 'Studio Shoots',
            timeZone: 'Asia/Kolkata',
            isPrimary: true,
            syncEnabled: true,
          },
        ],
        uncertainCount: 0,
      },
    });

    renderAuthed(<GoogleCalendarIntegrationCard />);

    await waitFor(() => {
      expect(screen.getByText('Connected')).toBeInTheDocument();
      expect(screen.getByText('photographer@studio.com')).toBeInTheDocument();
      expect(screen.getByText('Studio Shoots')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Sync Now/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Disconnect/i })).toBeInTheDocument();
    });
  });

  it('renders "Re-auth Required" when connection status is needs_reauth', async () => {
    endpoints.getGoogleCalendarStatus.mockResolvedValue({
      data: {
        connected: false,
        connection: {
          id: 'conn_2',
          accountEmail: 'owner@studio.com',
          status: 'needs_reauth',
          lastSyncError: 'Token expired',
        },
        calendars: [],
        uncertainCount: 0,
      },
    });

    renderAuthed(<GoogleCalendarIntegrationCard />);

    await waitFor(() => {
      expect(screen.getByText('Re-auth Required')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Reconnect Google Calendar/i })).toBeInTheDocument();
    });
  });

  it('triggers sync when "Sync Now" button is clicked', async () => {
    endpoints.getGoogleCalendarStatus.mockResolvedValue({
      data: {
        connected: true,
        connection: {
          id: 'conn_1',
          accountEmail: 'photographer@studio.com',
          status: 'connected',
        },
        calendars: [],
        uncertainCount: 0,
      },
    });
    endpoints.syncGoogleCalendarNow.mockResolvedValue({
      data: {
        success: true,
        stats: { created: 2, updated: 1, cancelled: 0 },
      },
    });

    renderAuthed(<GoogleCalendarIntegrationCard />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Sync Now/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Sync Now/i }));

    await waitFor(() => {
      expect(endpoints.syncGoogleCalendarNow).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/Sync complete: 2 created, 1 updated, 0 cancelled/i)).toBeInTheDocument();
    });
  });
});

