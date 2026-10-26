import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import {
  createStarredMessage,
  deleteStarredMessage,
  listStarredMessages,
  updateStarredMessage,
} from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { type StarredMessage } from '../../types';
import { type AuthValue, errorMessage } from '../types';

/**
 * One user's saved replies: create, search, edit, delete, and insert into the composer.
 *
 * INSERTING NEVER SENDS. `onUse` hands the text up to the composer and closes this panel; the
 * message then sits in the box exactly as if it had been typed, and the user presses Send
 * themselves. That is the whole point of the feature - a saved reply is a starting draft, and
 * the one before it on a lead is rarely word-for-word right for the next.
 *
 * SEARCH IS SERVER-SIDE AND DEBOUNCED. The list is capped at 200 rows, so filtering in the
 * browser would quietly stop finding things once somebody passes that - and the cap is the
 * sort of number nobody revisits. Debounced because this fires on every keystroke.
 *
 * DELETING ASKS FIRST. There is no undo, and the row is one click from the Use button.
 */

interface Props {
  /** Fills the composer with this text and closes the panel. Never sends. */
  onUse?: (body: string) => void;
  /** Lets the parent refresh the stars on the message bubbles after a change here. */
  onChanged?: () => void;
}

type Draft = { title: string; body: string };

const EMPTY_DRAFT: Draft = { title: '', body: '' };

const StarredMessagesSection = ({ onUse, onChanged }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;

  const [items, setItems] = useState<StarredMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  /**
   * Bumped to force a refetch. Needed because the obvious "set the search to what it already
   * is" does nothing - React bails out of an identical state value, so the effect never reruns
   * and Try again would silently do nothing.
   */
  const [reloadKey, setReloadKey] = useState(0);

  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [creating, setCreating] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY_DRAFT);
  const [savingId, setSavingId] = useState<string | null>(null);

  /**
   * Guards against a slow early response landing after a later one and replacing newer results
   * with older. Every load takes a ticket; only the newest is allowed to write state.
   */
  const loadTicket = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 250);

    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const ticket = loadTicket.current + 1;
    loadTicket.current = ticket;

    let active = true;

    // The spinner for the fetch this effect is about to start. Every other state write here
    // happens after the request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);

    authedRequest((token) =>
      listStarredMessages({ token, search: debouncedSearch || undefined }),
    )
      .then((payload) => {
        if (!active || loadTicket.current !== ticket) {
          return;
        }

        setItems(payload.data ?? []);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!active || loadTicket.current !== ticket) {
          return;
        }

        setError(errorMessage(cause, 'Could not load your starred messages.'));
      })
      .finally(() => {
        if (active && loadTicket.current === ticket) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [authedRequest, debouncedSearch, reloadKey]);

  const reload = () => setReloadKey((previous) => previous + 1);

  const canCreate = useMemo(
    () => draft.title.trim() !== '' && draft.body.trim() !== '' && !creating,
    [draft, creating],
  );

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();

    if (!canCreate) {
      return;
    }

    setCreating(true);
    setError(null);

    try {
      const payload = await authedRequest((token) =>
        createStarredMessage({
          token,
          title: draft.title.trim(),
          body: draft.body.trim(),
        }),
      );

      // Prepended rather than refetched: the list is sorted newest-first, so this is the same
      // answer the server would give and it costs no round trip.
      if (payload.data) {
        setItems((previous) => [payload.data as StarredMessage, ...previous]);
      }

      setDraft(EMPTY_DRAFT);
      onChanged?.();
    } catch (cause: unknown) {
      setError(errorMessage(cause, 'Could not save that message.'));
    } finally {
      setCreating(false);
    }
  };

  const handleSaveEdit = async (id: string) => {
    if (editDraft.title.trim() === '' || editDraft.body.trim() === '') {
      return;
    }

    setSavingId(id);
    setError(null);

    try {
      const payload = await authedRequest((token) =>
        updateStarredMessage({
          token,
          starredMessageId: id,
          title: editDraft.title.trim(),
          body: editDraft.body.trim(),
        }),
      );

      setItems((previous) =>
        previous.map((item) => (item.id === id ? (payload.data as StarredMessage) ?? item : item)),
      );
      setEditingId(null);
      onChanged?.();
    } catch (cause: unknown) {
      setError(errorMessage(cause, 'Could not update that message.'));
    } finally {
      setSavingId(null);
    }
  };

  const handleDelete = async (item: StarredMessage) => {
    if (!window.confirm(`Delete the saved message "${item.title}"? This cannot be undone.`)) {
      return;
    }

    setSavingId(item.id);
    setError(null);

    try {
      await authedRequest((token) =>
        deleteStarredMessage({ token, starredMessageId: item.id }),
      );

      setItems((previous) => previous.filter((candidate) => candidate.id !== item.id));
      onChanged?.();
    } catch (cause: unknown) {
      setError(errorMessage(cause, 'Could not delete that message.'));
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <form onSubmit={handleCreate} aria-label="Save a new message" className="space-y-2">
        <input
          aria-label="Title"
          value={draft.title}
          onChange={(event) => setDraft((previous) => ({ ...previous, title: event.target.value }))}
          placeholder="Title, e.g. Drone coverage"
          maxLength={120}
          className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm text-slate-800 focus:border-blue-500 focus:outline-none"
        />
        <textarea
          aria-label="Message"
          value={draft.body}
          onChange={(event) => setDraft((previous) => ({ ...previous, body: event.target.value }))}
          placeholder="The message you want to reuse…"
          rows={3}
          maxLength={4000}
          className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm text-slate-800 focus:border-blue-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={!canCreate}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {creating ? 'Saving…' : 'Save message'}
        </button>
      </form>

      <div>
        <input
          type="search"
          aria-label="Search starred messages"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search saved messages…"
          className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm text-slate-800 focus:border-blue-500 focus:outline-none"
        />
      </div>

      {error ? (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className="text-xs text-slate-500">Loading…</p>
      ) : error ? (
        // Deliberately NOT the empty state. A failed load with "No saved messages yet" under
        // it tells the user their saved replies are gone, which is both alarming and false.
        null
      ) : items.length === 0 ? (
        <p className="text-xs text-slate-500">
          {debouncedSearch === ''
            ? 'No saved messages yet. Star one in a chat, or write one above.'
            : 'Nothing matches that search.'}
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.id} className="rounded-xl border border-slate-200 p-2.5">
              {editingId === item.id ? (
                <div className="space-y-2">
                  <input
                    aria-label={`Edit title for ${item.title}`}
                    value={editDraft.title}
                    onChange={(event) =>
                      setEditDraft((previous) => ({ ...previous, title: event.target.value }))
                    }
                    maxLength={120}
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm text-slate-800 focus:border-blue-500 focus:outline-none"
                  />
                  <textarea
                    aria-label={`Edit message for ${item.title}`}
                    value={editDraft.body}
                    onChange={(event) =>
                      setEditDraft((previous) => ({ ...previous, body: event.target.value }))
                    }
                    rows={3}
                    maxLength={4000}
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm text-slate-800 focus:border-blue-500 focus:outline-none"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void handleSaveEdit(item.id)}
                      disabled={savingId === item.id}
                      className="rounded-lg bg-blue-600 px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50"
                    >
                      {savingId === item.id ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="text-sm font-semibold text-slate-900">{item.title}</p>
                  {/* Clamped: a saved quote can run to several hundred characters, and the list
                      is for choosing between them, not reading them. */}
                  <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words text-xs text-slate-600">
                    {item.body}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {onUse ? (
                      <button
                        type="button"
                        onClick={() => onUse(item.body)}
                        className="rounded-lg bg-blue-600 px-2.5 py-1 text-xs font-semibold text-white"
                      >
                        Use
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(item.id);
                        setEditDraft({ title: item.title, body: item.body });
                      }}
                      className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete(item)}
                      disabled={savingId === item.id}
                      className="rounded-lg border border-red-300 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Kept so a failed load has a way back that is not "close and reopen". */}
      {error && !loading ? (
        <button
          type="button"
          onClick={reload}
          className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
};

export default StarredMessagesSection;
