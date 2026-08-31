import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import TagsSection from '../components/lead/TagsSection';
import * as endpointsApi from '../api/endpoints';
import { PERMISSIONS } from '../lib/permissions';
import { AUTH_PAYLOAD, renderAuthed } from './lead-helpers';

// Tests may use `any` for Vitest mocks of untyped endpoint modules.
const endpoints = endpointsApi as any;

vi.mock('../api/endpoints');

const TAGS = [
  { id: 't1', name: 'VIP', slug: 'vip', status: 'active' },
  { id: 't2', name: 'Hot', slug: 'hot', status: 'active' },
];

beforeEach(() => {
  endpoints.listTags.mockResolvedValue({ data: TAGS });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('TagsSection', () => {
  it('attaches and detaches tags when the user can manage tags', async () => {
    endpoints.refresh.mockResolvedValue(
      AUTH_PAYLOAD({ role: 'admin', permissions: [PERMISSIONS.CRM_TAGS_MANAGE] }),
    );
    endpoints.attachTag.mockResolvedValue({ data: { conversationId: 'c1', tags: ['t1'] } });
    endpoints.detachTag.mockResolvedValue({ data: { conversationId: 'c1', tags: [] } });

    renderAuthed(<TagsSection conversationId="c1" tagIds={[]} onTagsChange={vi.fn()} />);

    const addSelect = await screen.findByLabelText('Add tag');
    fireEvent.change(addSelect, { target: { value: 't1' } });

    await waitFor(() =>
      expect(endpoints.attachTag).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'c1', tagId: 't1' }),
      ),
    );

    // The attached tag now renders as a chip with a remove control.
    const removeButton = await screen.findByRole('button', { name: 'Remove VIP' });
    fireEvent.click(removeButton);

    await waitFor(() =>
      expect(endpoints.detachTag).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'c1', tagId: 't1' }),
      ),
    );
  });

  it('hides the tag controls without crm.tags.manage', async () => {
    endpoints.refresh.mockResolvedValue(AUTH_PAYLOAD({ role: 'staff', permissions: [] }));

    renderAuthed(<TagsSection conversationId="c1" tagIds={['t1']} onTagsChange={vi.fn()} />);

    expect(await screen.findByText('VIP')).toBeInTheDocument();
    expect(screen.queryByLabelText('Add tag')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove VIP' })).not.toBeInTheDocument();
  });
});
