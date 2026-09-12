import { type FormEvent, useState } from 'react';

import { archiveAiKnowledge, deleteAiKnowledge, updateAiKnowledge } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { AI_KNOWLEDGE_CATEGORIES, AI_KNOWLEDGE_CATEGORY_HINTS } from '../../lib/ai-knowledge';
import { type AiKnowledgeCategory } from '../../types';
import { type AiKnowledge, type AuthValue, errorMessage } from '../types';

type Props = {
  knowledge: AiKnowledge;
  canManage: boolean;
  onChanged?: () => void;
};

const KnowledgeRow = ({ knowledge, canManage, onChanged }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isArchived = knowledge.status === 'archived';

  // Editing is inline rather than a modal: a fact is three short fields, and the point of the
  // page is comparing it against its neighbours while you correct it.
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(knowledge.label);
  const [content, setContent] = useState(knowledge.content);
  const [category, setCategory] = useState<AiKnowledgeCategory>(knowledge.category);

  const startEditing = () => {
    // Re-seed from the entry each time, so cancelling and reopening does not resurrect a
    // half-typed edit from before.
    setLabel(knowledge.label);
    setContent(knowledge.content);
    setCategory(knowledge.category);
    setError(null);
    setEditing(true);
  };

  /**
   * Offered alongside Archive rather than instead of it. Archive retires a fact - it stops
   * binding the AI but the record of what it was once told survives. This is for entries that
   * should never have existed, so it confirms first and cannot be undone.
   */
  const handleDelete = async () => {
    if (
      !window.confirm(
        `Delete "${knowledge.label}" permanently? Archive instead if you only want the AI to ` +
          'stop using it.',
      )
    ) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      await authedRequest((token) => deleteAiKnowledge({ token, knowledgeId: knowledge.id }));
      onChanged?.();
    } catch (deleteError: unknown) {
      setError(errorMessage(deleteError, 'Unable to delete.'));
      setBusy(false);
    }
  };

  const handleArchive = async () => {
    setBusy(true);
    setError(null);
    try {
      await authedRequest((token) => archiveAiKnowledge({ token, knowledgeId: knowledge.id }));
      onChanged?.();
    } catch (archiveError: unknown) {
      setError(errorMessage(archiveError, 'Unable to archive.'));
      setBusy(false);
    }
  };

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || label.trim() === '' || content.trim() === '') {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      await authedRequest((token) =>
        updateAiKnowledge({
          token,
          knowledgeId: knowledge.id,
          label: label.trim(),
          content: content.trim(),
          category,
        }),
      );
      setEditing(false);
      onChanged?.();
    } catch (saveError: unknown) {
      setError(errorMessage(saveError, 'Unable to save changes.'));
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <li className="border-b border-slate-100 px-4 py-3">
        <form onSubmit={handleSave} aria-label={`Edit ${knowledge.label}`} className="space-y-3">
          <div>
            <label
              htmlFor={`knowledge-label-${knowledge.id}`}
              className="mb-1 block text-xs font-medium text-slate-600"
            >
              Label
            </label>
            <input
              id={`knowledge-label-${knowledge.id}`}
              required
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor={`knowledge-content-${knowledge.id}`}
              className="mb-1 block text-xs font-medium text-slate-600"
            >
              Fact
            </label>
            <textarea
              id={`knowledge-content-${knowledge.id}`}
              required
              rows={3}
              value={content}
              onChange={(event) => setContent(event.target.value)}
              className="w-full resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor={`knowledge-category-${knowledge.id}`}
              className="mb-1 block text-xs font-medium text-slate-600"
            >
              Category
            </label>
            <select
              id={`knowledge-category-${knowledge.id}`}
              value={category}
              onChange={(event) => setCategory(event.target.value as AiKnowledgeCategory)}
              className="w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm capitalize text-slate-900 focus:border-blue-500 focus:outline-none"
            >
              {AI_KNOWLEDGE_CATEGORIES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-slate-500">{AI_KNOWLEDGE_CATEGORY_HINTS[category]}</p>
          </div>

          {error ? (
            <p role="alert" className="text-xs text-red-600">
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              disabled={busy || label.trim() === '' || content.trim() === ''}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={busy}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li className="flex flex-col gap-3 border-b border-slate-100 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-semibold text-slate-900">{knowledge.label}</span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold capitalize text-slate-500">
            {knowledge.category}
          </span>
          {isArchived ? (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-500">
              Archived
            </span>
          ) : null}
        </div>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-600">
          {knowledge.content}
        </p>
        {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : null}
      </div>

      {canManage ? (
        <div className="flex shrink-0 items-center gap-2">
          {/* Edit and Archive act on a live fact. Delete stays available on an archived one too -
              clearing out old entries is the main reason to reach for it. */}
          {!isArchived ? (
            <>
              <button
                type="button"
                onClick={startEditing}
                disabled={busy}
                className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={handleArchive}
                disabled={busy}
                className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Archive
              </button>
            </>
          ) : null}
          <button
            type="button"
            onClick={handleDelete}
            disabled={busy}
            className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:border-danger/50 hover:text-danger disabled:opacity-50"
          >
            Delete
          </button>
        </div>
      ) : null}
    </li>
  );
};

export default KnowledgeRow;
