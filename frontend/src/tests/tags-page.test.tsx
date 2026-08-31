import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as endpointsApi from '../api/endpoints';
import { PERMISSIONS } from '../lib/permissions';
import TagsPage from '../pages/TagsPage';
import { AUTH_PAYLOAD, renderAuthed } from './lead-helpers';

// Tests may use `any` for Vitest mocks of untyped endpoint modules.
const endpoints = endpointsApi as any;

vi.mock('../api/endpoints');

const TAGS = [
  { id: 't1', name: 'Budget 50L+', slug: 'budget-50l', color: '#ff8800', status: 'active' },
  { id: 't2', name: 'Walk-in', slug: 'walk-in', color: '#94a3b8', status: 'archived' },
];

beforeEach(() => {
  endpoints.listTags.mockResolvedValue({ data: TAGS });
});

afterEach(() => {
  vi.clearAllMocks();
});

const asAdmin = () =>
  endpoints.refresh.mockResolvedValue(
    AUTH_PAYLOAD({ role: 'admin', permissions: [PERMISSIONS.CRM_TAGS_MANAGE] }),
  );

describe('TagsPage', () => {
  it('separates active tags from archived ones', async () => {
    asAdmin();
    renderAuthed(<TagsPage />);

    expect(await screen.findByText('Budget 50L+')).toBeInTheDocument();

    // "Archived" is both the section heading and the row's own badge.
    const archivedRow = screen.getByText('Walk-in').closest('li') as HTMLElement;
    expect(within(archivedRow).getByText('Archived')).toBeInTheDocument();

    const activeRow = screen.getByText('Budget 50L+').closest('li') as HTMLElement;
    expect(within(activeRow).queryByText('Archived')).not.toBeInTheDocument();
  });

  it('creates a tag and lets the server derive the slug', async () => {
    asAdmin();
    endpoints.createTag.mockResolvedValue({ data: { id: 't3' } });
    renderAuthed(<TagsPage />);

    await screen.findByText('Budget 50L+');

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '2 BHK' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add tag' }));

    await waitFor(() =>
      expect(endpoints.createTag).toHaveBeenCalledWith(expect.objectContaining({ name: '2 BHK' })),
    );
    expect(endpoints.createTag.mock.calls[0][0].slug).toBeUndefined();
  });

  it('archives an active tag', async () => {
    asAdmin();
    endpoints.archiveTag.mockResolvedValue({ data: {} });
    renderAuthed(<TagsPage />);

    await screen.findByText('Budget 50L+');
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));

    await waitFor(() =>
      expect(endpoints.archiveTag).toHaveBeenCalledWith(expect.objectContaining({ tagId: 't1' })),
    );
  });

  it('offers no Archive button for an already-archived tag', async () => {
    asAdmin();
    renderAuthed(<TagsPage />);

    await screen.findByText('Walk-in');
    const archivedRow = screen.getByText('Walk-in').closest('li') as HTMLElement;
    expect(within(archivedRow).queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
  });

  it('hides management controls without crm.tags.manage', async () => {
    endpoints.refresh.mockResolvedValue(AUTH_PAYLOAD({ role: 'staff', permissions: [] }));

    renderAuthed(<TagsPage />);

    await screen.findByText('Budget 50L+');
    expect(screen.queryByRole('button', { name: 'Add tag' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
  });
});
