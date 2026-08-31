import { type FormEvent, useState } from 'react';

import { createAiKnowledge } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { type AuthValue, errorMessage } from '../types';

const CATEGORIES = ['pricing', 'policy', 'product', 'faq', 'other'] as const;

type KnowledgeCategory = (typeof CATEGORIES)[number];

type Props = {
  onCreated?: () => void;
};

const AddKnowledgeForm = ({ onCreated }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;
  const [label, setLabel] = useState('');
  const [content, setContent] = useState('');
  const [category, setCategory] = useState<KnowledgeCategory>('other');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || label.trim() === '' || content.trim() === '') {
      return;
    }
    setSaving(true);
    setError(null);

    try {
      await authedRequest((token) =>
        createAiKnowledge({ token, label: label.trim(), content: content.trim(), category }),
      );
      setLabel('');
      setContent('');
      setCategory('other');
      onCreated?.();
    } catch (submitError: unknown) {
      setError(errorMessage(submitError, 'Unable to add knowledge entry.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      aria-label="Add a knowledge entry"
      className="rounded-xl border border-slate-200 bg-white p-4"
    >
      <h3 className="mb-3 text-sm font-semibold text-slate-900">Add a fact</h3>
      <div className="space-y-3">
        <div>
          <label
            htmlFor="knowledge-label"
            className="mb-1 block text-xs font-medium text-slate-600"
          >
            Label
          </label>
          <input
            id="knowledge-label"
            required
            placeholder="Warranty policy"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div>
          <label
            htmlFor="knowledge-content"
            className="mb-1 block text-xs font-medium text-slate-600"
          >
            Fact
          </label>
          <textarea
            id="knowledge-content"
            required
            rows={3}
            placeholder="Warranty is two years. Never promise same-day delivery."
            value={content}
            onChange={(event) => setContent(event.target.value)}
            className="w-full resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div>
          <label
            htmlFor="knowledge-category"
            className="mb-1 block text-xs font-medium text-slate-600"
          >
            Category
          </label>
          <select
            id="knowledge-category"
            value={category}
            onChange={(event) => setCategory(event.target.value as KnowledgeCategory)}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm capitalize text-slate-900 focus:border-blue-500 focus:outline-none"
          >
            {CATEGORIES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={saving || label.trim() === '' || content.trim() === ''}
        className="mt-3 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300"
      >
        {saving ? 'Adding…' : 'Add fact'}
      </button>
    </form>
  );
};

export default AddKnowledgeForm;
