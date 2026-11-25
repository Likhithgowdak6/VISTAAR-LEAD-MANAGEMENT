import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as endpointsApi from '../api/endpoints';
import { PERMISSIONS } from '../lib/permissions';
import SettingsPage from '../pages/SettingsPage';
import { AUTH_PAYLOAD, renderAuthed } from './lead-helpers';

// Tests may use `any` for Vitest mocks of untyped endpoint modules.
const endpoints = endpointsApi as any;

vi.mock('../api/endpoints');

/**
 * Two panels share this page and neither is what these tests are about.
 *
 * Left unmocked they make real fetches, fail, and render their own `role="alert"` — which then
 * shadows the alert each assertion below is actually looking for. Their own behaviour lives in
 * `instagram-settings.test.tsx` and `capi-settings.test.tsx`.
 */
vi.mock('../api/instagram', () => ({
  listInstagramAccounts: vi.fn().mockResolvedValue({ data: [] }),
  listInstagramCandidates: vi.fn().mockResolvedValue({ data: [] }),
  connectInstagramAccount: vi.fn(),
  updateInstagramAutomation: vi.fn(),
  disconnectInstagramAccount: vi.fn(),
  setInstagramTakeover: vi.fn(),
}));

vi.mock('../api/capi', () => ({
  getCapiConnection: vi.fn().mockResolvedValue({
    data: { connected: false, enabled: false, selectedEvents: [], availableEvents: [] },
  }),
  getCapiStatus: vi.fn().mockResolvedValue({
    data: { counts: {}, maxAttempts: 6, recentFailures: [] },
  }),
  connectCapi: vi.fn(),
  setCapiEnabled: vi.fn(),
  setCapiEvents: vi.fn(),
}));

const OWNER_NUMBER_LABEL = 'Owner WhatsApp number';

beforeEach(() => {
  endpoints.getSettings.mockResolvedValue({ data: { ownerWhatsappNumber: '918183003081' } });
});

afterEach(() => {
  vi.clearAllMocks();
});

const asAdmin = () =>
  endpoints.refresh.mockResolvedValue(
    AUTH_PAYLOAD({ role: 'admin', permissions: [PERMISSIONS.SETTINGS_MANAGE] }),
  );

describe('SettingsPage', () => {
  it('shows the owner number currently saved for the organization', async () => {
    asAdmin();
    renderAuthed(<SettingsPage />);

    expect(await screen.findByLabelText(OWNER_NUMBER_LABEL)).toHaveValue('918183003081');
  });

  it('saves a new number and confirms it', async () => {
    asAdmin();
    endpoints.updateSettings.mockResolvedValue({ data: { ownerWhatsappNumber: '919876543210' } });
    renderAuthed(<SettingsPage />);

    const field = await screen.findByLabelText(OWNER_NUMBER_LABEL);
    fireEvent.change(field, { target: { value: '+91 98765 43210' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(endpoints.updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ ownerWhatsappNumber: '+91 98765 43210' }),
      ),
    );
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(screen.getByLabelText(OWNER_NUMBER_LABEL)).toHaveValue('919876543210');
  });

  it('clears the setting by sending null when the field is emptied', async () => {
    asAdmin();
    endpoints.updateSettings.mockResolvedValue({ data: { ownerWhatsappNumber: null } });
    renderAuthed(<SettingsPage />);

    fireEvent.change(await screen.findByLabelText(OWNER_NUMBER_LABEL), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(endpoints.updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ ownerWhatsappNumber: null }),
      ),
    );
  });

  it('shows the error when the save is rejected', async () => {
    asAdmin();
    endpoints.updateSettings.mockRejectedValue(new Error('Enter at least 8 digits.'));
    renderAuthed(<SettingsPage />);

    fireEvent.change(await screen.findByLabelText(OWNER_NUMBER_LABEL), { target: { value: '123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Enter at least 8 digits.');
    expect(screen.queryByText('Saved.')).not.toBeInTheDocument();
  });

  it('hides the save control without settings.manage', async () => {
    endpoints.refresh.mockResolvedValue(AUTH_PAYLOAD({ role: 'staff', permissions: [] }));

    renderAuthed(<SettingsPage />);

    expect(await screen.findByLabelText(OWNER_NUMBER_LABEL)).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });
});
