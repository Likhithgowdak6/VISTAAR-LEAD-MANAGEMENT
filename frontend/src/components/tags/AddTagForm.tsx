import { type FormEvent, useState } from 'react';

import { createTag } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { type AuthValue, errorMessage } from '../types';

const DEFAULT_COLOR = '#64748b';

type Props = {
  onCreated?: () => void;
};

const AddTagForm = ({ onCreated }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;
  const [name, setName] = useState('');
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || name.trim() === '') {
      return;
    }
    setSaving(true);
    setError(null);

    try {
      // The server derives the slug from the name when one is not supplied.
      await authedRequest((token) =>
        createTag({
          token,
          name: name.trim(),
          color,
          description: description.trim() || undefined,
          slug: undefined,
        }),
      );
      setName('');
      setColor(DEFAULT_COLOR);
      setDescription('');
      onCreated?.();
    } catch (submitError: unknown) {
      setError(errorMessage(submitError, 'Unable to add tag.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      aria-label="Add a tag"
      className="rounded-xl border border-slate-200 bg-white p-4"
    >
      <h3 className="mb-3 text-sm font-semibold text-slate-900">Add a tag</h3>
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <label htmlFor="tag-name" className="mb-1 block text-xs font-medium text-slate-600">
            Name
          </label>
          <input
            id="tag-name"
            required
            placeholder="Budget 50L+"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="tag-color" className="mb-1 block text-xs font-medium text-slate-600">
            Color
          </label>
          <input
            id="tag-color"
            type="color"
            value={color}
            onChange={(event) => setColor(event.target.value)}
            className="h-9 w-14 rounded-lg border border-slate-300"
          />
        </div>
      </div>

      <div className="mt-3">
        <label htmlFor="tag-description" className="mb-1 block text-xs font-medium text-slate-600">
          Description <span className="text-slate-400">(optional)</span>
        </label>
        <input
          id="tag-description"
          placeholder="When to use this tag"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
        />
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={saving || name.trim() === ''}
        className="mt-3 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300"
      >
        {saving ? 'Adding…' : 'Add tag'}
      </button>
    </form>
  );
};

export default AddTagForm;
