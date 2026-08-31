import { type ChangeEvent, useCallback, useEffect, useState } from 'react';

import { changeStage, listStages } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { BUILTIN_STAGES, mergeStages } from '../../lib/stages';
import { type AuthValue, errorMessage, type StageOption } from '../types';

type Props = {
  conversationId: string;
  stage?: string | null;
  onStageChange?: (stage: string) => void;
};

const StageControl = ({ conversationId, stage, onStageChange }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;
  const [stages, setStages] = useState<StageOption[]>(mergeStages());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStages = useCallback(async () => {
    try {
      const payload = await authedRequest((token) => listStages({ token, status: 'active' }));
      setStages(mergeStages(payload.data ?? []));
    } catch {
      // Falls back to the built-ins only; the picker still works, just without custom stages.
    }
  }, [authedRequest]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadStages();
  }, [loadStages]);

  // The conversation's current stage might have since been archived — keep it selectable so the
  // dropdown doesn't silently fall back to a different value out from under the user.
  const options: StageOption[] =
    stage && !stages.some((option) => option.key === stage)
      ? [...stages, { key: stage, label: stage, color: null, status: 'active' }]
      : stages;

  const handleChange = async (event: ChangeEvent<HTMLSelectElement>) => {
    const nextStage = event.target.value;
    setSaving(true);
    setError(null);

    try {
      const payload = await authedRequest((token) =>
        changeStage({ token, conversationId, stage: nextStage }),
      );
      onStageChange?.(payload.data?.stage ?? nextStage);
    } catch (changeError: unknown) {
      setError(errorMessage(changeError, 'Unable to change stage.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <label
        htmlFor="lead-stage"
        className="mb-1 block text-xs font-semibold uppercase text-slate-500"
      >
        Stage
      </label>
      <select
        id="lead-stage"
        value={stage ?? (BUILTIN_STAGES[0] as { key: string }).key}
        onChange={handleChange}
        disabled={saving}
        className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-900 focus:border-blue-500 focus:outline-none disabled:opacity-60"
      >
        {options.map((option) => (
          <option key={option.key} value={option.key}>
            {option.label}
          </option>
        ))}
      </select>
      {error ? (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
};

export default StageControl;
