import { type ChangeEvent, useCallback, useEffect, useState } from 'react';

import { changeAiCategory, listAiCategories } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { type AuthValue, errorMessage } from '../types';

type Props = {
  conversationId: string;
  /** The backend's `aiCategory` - a playbook key like `birthday`, or `unknown`/absent. */
  aiCategory?: string | null;
  onCategoryChange?: (aiCategory: string) => void;
};

/** `half_saree` -> `Half saree`. The keys are snake_case; nobody wants to read that. */
const labelFor = (key: string): string => {
  const spaced = key.replace(/_/g, ' ');

  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

const UNKNOWN = 'unknown';

/**
 * Which service playbook this enquiry is handled under, and the only way to correct it.
 *
 * Not cosmetic: the category decides which questions the AI asks, which brief it reads, and which
 * proposal template gets rendered (see the backend's ai-brain/category-playbooks.ts). The model
 * classifies once and then deliberately refuses to change its own mind - that stops it swapping
 * the playbook mid-conversation, but it also means a bad first guess sticks forever unless a
 * person can intervene. This is that intervention.
 *
 * `unknown` is shown rather than hidden, deliberately. A conversation the AI has not classified is
 * running on the generic fallback, and that is exactly what an owner would want to notice on a lead
 * that has been talking for a while - hiding it would make the generic case indistinguishable from
 * a correctly classified one.
 */
const ServiceSection = ({ conversationId, aiCategory, onCategoryChange }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;
  const category = (aiCategory ?? '').trim() || UNKNOWN;

  const [categories, setCategories] = useState<string[]>([category]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadCategories = useCallback(async () => {
    try {
      const payload = await authedRequest((token) => listAiCategories({ token }));
      setCategories(payload.data ?? []);
    } catch {
      // Leaves the picker holding just the current value: it still renders and still reads
      // correctly, it simply cannot be changed until the list loads.
    }
  }, [authedRequest]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadCategories();
  }, [loadCategories]);

  // A category stored by an older build might not be in the table any more - keep it selectable
  // so the dropdown never silently shows a different service than the one in the database.
  const options = categories.includes(category) ? categories : [...categories, category];

  const handleChange = async (event: ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value;
    setSaving(true);
    setError(null);

    try {
      const payload = await authedRequest((token) =>
        changeAiCategory({ token, conversationId, aiCategory: next }),
      );
      onCategoryChange?.(payload.data?.aiCategory ?? next);
    } catch (changeError: unknown) {
      setError(errorMessage(changeError, 'Unable to change the service.'));
    } finally {
      setSaving(false);
    }
  };

  const unclassified = category === UNKNOWN;

  return (
    <div>
      <label
        htmlFor="lead-service"
        className="mb-1 block text-xs font-semibold uppercase text-slate-500"
      >
        Service
      </label>
      <select
        id="lead-service"
        value={category}
        onChange={handleChange}
        disabled={saving}
        className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-900 focus:border-blue-500 focus:outline-none disabled:opacity-60"
      >
        {options.map((key) => (
          <option key={key} value={key}>
            {key === UNKNOWN ? 'Not identified yet' : labelFor(key)}
          </option>
        ))}
      </select>
      {unclassified ? (
        <p className="mt-1 text-xs text-slate-400">
          Using the general playbook until the lead says what the occasion is. Set it yourself to
          steer the AI&apos;s questions now.
        </p>
      ) : (
        <p className="mt-1 text-xs text-slate-400">
          Decides which questions the AI asks and which brief it follows.
        </p>
      )}
      {error ? (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
};

export default ServiceSection;
