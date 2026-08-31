import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as endpointsApi from '../api/endpoints';
import { PERMISSIONS } from '../lib/permissions';
import StagesPage from '../pages/StagesPage';
import { AUTH_PAYLOAD, renderAuthed } from './lead-helpers';

// Tests may use `any` for Vitest mocks of untyped endpoint modules.
const endpoints = endpointsApi as any;

vi.mock('../api/endpoints');

const STAGES = [
  { id: 's1', key: 'hot-lead', label: 'Hot Lead', color: '#ff8800', status: 'active' },
  { id: 's2', key: 'cold-lead', label: 'Cold Lead', color: '#94a3b8', status: 'archived' },
];

beforeEach(() => {
  endpoints.listStages.mockResolvedValue({ data: STAGES });
});

afterEach(() => {
  vi.clearAllMocks();
});

const asAdmin = () =>
  endpoints.refresh.mockResolvedValue(
    AUTH_PAYLOAD({ role: 'admin', permissions: [PERMISSIONS.CRM_STAGE_MANAGE] }),
  );

describe('StagesPage', () => {
  it('lists the permanent built-ins and the custom stages with their status', async () => {
    asAdmin();
    renderAuthed(<StagesPage />);

    expect(await screen.findByText('New')).toBeInTheDocument();
    expect(screen.getByText('Won')).toBeInTheDocument();
    expect(screen.getByText('Hot Lead')).toBeInTheDocument();
    expect(screen.getByText('Cold Lead')).toBeInTheDocument();
    expect(screen.getByText('Archived')).toBeInTheDocument();
  });

  it('creates a new custom stage', async () => {
    asAdmin();
    endpoints.createStage.mockResolvedValue({ data: { id: 's3' } });
    renderAuthed(<StagesPage />);

    await screen.findByText('Hot Lead');

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Warm Lead' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add stage' }));

    await waitFor(() =>
      expect(endpoints.createStage).toHaveBeenCalledWith(
        expect.objectContaining({ label: 'Warm Lead' }),
      ),
    );
  });

  it('archives an active custom stage', async () => {
    asAdmin();
    endpoints.archiveStage.mockResolvedValue({ data: {} });
    renderAuthed(<StagesPage />);

    await screen.findByText('Hot Lead');
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));

    await waitFor(() =>
      expect(endpoints.archiveStage).toHaveBeenCalledWith(
        expect.objectContaining({ stageId: 's1' }),
      ),
    );
  });

  it('permanently deletes a custom stage — a distinct action from archiving', async () => {
    asAdmin();
    endpoints.deleteStage.mockResolvedValue({ data: {} });
    renderAuthed(<StagesPage />);

    await screen.findByText('Hot Lead');

    const hotLeadRow = screen.getByText('Hot Lead').closest('li') as HTMLElement;
    fireEvent.click(within(hotLeadRow).getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(endpoints.deleteStage).toHaveBeenCalledWith(
        expect.objectContaining({ stageId: 's1' }),
      ),
    );
  });

  it('offers Delete but not Archive for an already-archived stage', async () => {
    asAdmin();
    renderAuthed(<StagesPage />);

    await screen.findByText('Cold Lead');
    const coldLeadRow = screen.getByText('Cold Lead').closest('li') as HTMLElement;
    expect(within(coldLeadRow).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(within(coldLeadRow).queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
  });

  it('hides management controls without crm.stage.manage', async () => {
    endpoints.refresh.mockResolvedValue(AUTH_PAYLOAD({ role: 'staff', permissions: [] }));

    renderAuthed(<StagesPage />);

    await screen.findByText('Hot Lead');
    expect(screen.queryByRole('button', { name: 'Add stage' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });
});
