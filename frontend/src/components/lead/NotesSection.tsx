import { type FormEvent, useCallback, useEffect, useState } from 'react';

import { createNote, deleteNote, listNotes } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { allowedNoteVisibilityForRole, NOTE_VISIBILITY } from '../../lib/permissions';
import { type NoteVisibility } from '../../types';
import EmptyState from '../EmptyState';
import RelativeTime from '../RelativeTime';
import Spinner from '../Spinner';
import { type AuthValue, errorMessage, type Note } from '../types';

type Props = {
  conversationId: string;
};

const NotesSection = ({ conversationId }: Props) => {
  const { authedRequest, user } = useAuth() as AuthValue;
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const allowedVisibilities = allowedNoteVisibilityForRole(user?.role);
  const [visibility, setVisibility] = useState<NoteVisibility>(NOTE_VISIBILITY.SHARED);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const payload = await authedRequest((token) => listNotes({ token, conversationId }));
      setNotes(payload.data ?? []);
      setError(null);
    } catch (loadError: unknown) {
      setError(errorMessage(loadError, 'Unable to load notes.'));
    } finally {
      setLoading(false);
    }
  }, [authedRequest, conversationId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const handleAdd = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = body.trim();
    if (!trimmed || saving) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await authedRequest((token) =>
        createNote({ token, conversationId, body: trimmed, visibility }),
      );
      setBody('');
      await load();
    } catch (addError: unknown) {
      setError(errorMessage(addError, 'Unable to add note.'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (noteId: string) => {
    try {
      await authedRequest((token) => deleteNote({ token, conversationId, noteId }));
      await load();
    } catch (deleteError: unknown) {
      setError(errorMessage(deleteError, 'Unable to delete note.'));
    }
  };

  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase text-slate-500">Notes</h3>

      <form onSubmit={handleAdd} aria-label="Add note" className="mb-3 space-y-2">
        <textarea
          aria-label="Note"
          rows={2}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Add a note…"
          className="w-full resize-none rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
        />
        <div className="flex items-center gap-2">
          <select
            aria-label="Note visibility"
            value={visibility}
            onChange={(event) => setVisibility(event.target.value as NoteVisibility)}
            className="rounded-lg border border-slate-300 px-2 py-1 text-xs capitalize text-slate-700 focus:border-blue-500 focus:outline-none"
          >
            {allowedVisibilities.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={saving || body.trim() === ''}
            className="rounded-lg bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300"
          >
            {saving ? 'Adding…' : 'Add'}
          </button>
        </div>
      </form>

      {loading ? <Spinner label="Loading notes…" /> : null}
      {error ? (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      ) : null}
      {!loading && notes.length === 0 ? (
        <EmptyState compact title="No notes" description="Add the first note above." />
      ) : null}

      <ul className="space-y-2">
        {notes.map((note) => (
          <li key={note.id} className="rounded-lg bg-slate-50 p-2">
            <p className="whitespace-pre-wrap break-words text-sm text-slate-800">{note.body}</p>
            <div className="mt-1 flex items-center justify-between text-[11px] text-slate-400">
              <span className="capitalize">
                {note.visibility} · <RelativeTime value={note.createdAt} />
              </span>
              {note.createdBy === user?.id ? (
                <button
                  type="button"
                  onClick={() => handleDelete(note.id)}
                  className="font-medium text-red-500 hover:text-red-600"
                >
                  Delete
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
};

export default NotesSection;
