import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import NotesSection from '../components/lead/NotesSection';
import * as endpointsApi from '../api/endpoints';
import { AUTH_PAYLOAD, renderAuthed } from './lead-helpers';

// Tests may use `any` for Vitest mocks of untyped endpoint modules.
const endpoints = endpointsApi as any;

vi.mock('../api/endpoints');

afterEach(() => {
  vi.clearAllMocks();
});

describe('NotesSection', () => {
  it('renders notes and adds one with the chosen visibility', async () => {
    endpoints.refresh.mockResolvedValue(AUTH_PAYLOAD({ role: 'admin', permissions: [] }));
    endpoints.listNotes
      .mockResolvedValueOnce({
        data: [
          {
            id: 'n1',
            body: 'Existing note',
            visibility: 'shared',
            createdBy: 'other',
            createdAt: new Date().toISOString(),
          },
        ],
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: 'n1',
            body: 'Existing note',
            visibility: 'shared',
            createdBy: 'other',
            createdAt: new Date().toISOString(),
          },
          {
            id: 'n2',
            body: 'New note',
            visibility: 'manager',
            createdBy: 'u1',
            createdAt: new Date().toISOString(),
          },
        ],
      });
    endpoints.createNote.mockResolvedValue({ data: { id: 'n2' } });

    renderAuthed(<NotesSection conversationId="c1" />);

    expect(await screen.findByText('Existing note')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'New note' } });
    fireEvent.change(screen.getByLabelText('Note visibility'), { target: { value: 'manager' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(endpoints.createNote).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'c1', body: 'New note', visibility: 'manager' }),
      ),
    );
    expect(await screen.findByText('New note')).toBeInTheDocument();
  });

  it('limits the visibility options to the role (staff → shared only)', async () => {
    endpoints.refresh.mockResolvedValue(AUTH_PAYLOAD({ role: 'staff', permissions: [] }));
    endpoints.listNotes.mockResolvedValue({ data: [] });

    renderAuthed(<NotesSection conversationId="c1" />);

    await screen.findByLabelText('Note visibility');
    await waitFor(() => {
      const select = screen.getByLabelText('Note visibility');
      const options = within(select).getAllByRole('option');
      expect(options.map((option) => (option as HTMLOptionElement).value)).toEqual(['shared']);
    });
  });

  it('deletes the actor’s own note', async () => {
    endpoints.refresh.mockResolvedValue(AUTH_PAYLOAD({ role: 'admin', permissions: [] }));
    endpoints.listNotes
      .mockResolvedValueOnce({
        data: [
          {
            id: 'n1',
            body: 'Mine',
            visibility: 'shared',
            createdBy: 'u1',
            createdAt: new Date().toISOString(),
          },
        ],
      })
      .mockResolvedValueOnce({ data: [] });
    endpoints.deleteNote.mockResolvedValue({ data: { id: 'n1' } });

    renderAuthed(<NotesSection conversationId="c1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(endpoints.deleteNote).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'c1', noteId: 'n1' }),
      ),
    );
  });
});
