import { type FormEvent, useState } from 'react';

import { createStage } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { type AuthValue, errorMessage } from '../types';

const DEFAULT_COLOR = '#3b82f6';

type Props = {
  onCreated?: () => void;
};

const AddStageForm = ({ onCreated }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;
  const [label, setLabel] = useState('');
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || label.trim() === '') {
      return;
    }
    setSaving(true);
    setError(null);

    try {
      await authedRequest((token) =>
        createStage({ token, label: label.trim(), color, key: undefined }),
      );
      setLabel('');
      setColor(DEFAULT_COLOR);
      onCreated?.();
    } catch (submitError: unknown) {
      setError(errorMessage(submitError, 'Unable to add stage.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      aria-label="Add a stage"
      className="rounded-xl border border-slate-200 bg-white p-4"
    >
      <h3 className="mb-3 text-sm font-semibold text-slate-900">Add a stage</h3>
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <label htmlFor="stage-label" className="mb-1 block text-xs font-medium text-slate-600">
            Name
          </label>
          <input
            id="stage-label"
            required
            placeholder="Hot Lead"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="stage-color" className="mb-1 block text-xs font-medium text-slate-600">
            Color
          </label>
          <input
            id="stage-color"
            type="color"
            value={color}
            onChange={(event) => setColor(event.target.value)}
            className="h-9 w-14 rounded-lg border border-slate-300"
          />
        </div>
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={saving || label.trim() === ''}
        className="mt-3 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300"
      >
        {saving ? 'Adding…' : 'Add stage'}
      </button>
    </form>
  );
};

export default AddStageForm;
