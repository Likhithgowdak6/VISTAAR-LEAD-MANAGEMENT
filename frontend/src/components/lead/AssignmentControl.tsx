import { type ChangeEvent, useCallback, useEffect, useState } from 'react';

import { assignConversation, listUsers } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { type AuthValue, errorMessage, type TeamMember } from '../types';

const UNASSIGNED_VALUE = '';

type Props = {
  conversationId: string;
  assignedTo?: string | null;
  onAssignmentChange?: (assignedTo: string | null) => void;
};

const AssignmentControl = ({ conversationId, assignedTo, onAssignmentChange }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;
  const [members, setMembers] = useState<TeamMember[]>([]);
  // Seeded from the initial prop, then owned locally — mirrors TagsSection, since nothing
  // upstream refetches the conversation detail after the first load.
  const [currentAssignee, setCurrentAssignee] = useState<string | null>(assignedTo ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadMembers = useCallback(async () => {
    try {
      const payload = await authedRequest((token) => listUsers({ token }));
      setMembers((payload?.data as TeamMember[] | undefined) ?? []);
    } catch {
      // A failed member list just leaves the dropdown short; the assign action still works
      // for whichever member is already selected.
    }
  }, [authedRequest]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadMembers();
  }, [loadMembers]);

  const handleChange = async (event: ChangeEvent<HTMLSelectElement>) => {
    const nextValue = event.target.value;
    const nextAssignedTo = nextValue === UNASSIGNED_VALUE ? null : nextValue;

    setSaving(true);
    setError(null);

    try {
      const payload = await authedRequest((token) =>
        assignConversation({ token, conversationId, assignedTo: nextAssignedTo }),
      );
      const resolvedAssignee =
        (payload?.data?.assignedTo as string | null | undefined) ?? nextAssignedTo;
      setCurrentAssignee(resolvedAssignee);
      onAssignmentChange?.(resolvedAssignee);
    } catch (assignError: unknown) {
      setError(errorMessage(assignError, 'Unable to assign the conversation.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <label
        htmlFor="lead-assignment"
        className="mb-1 block text-xs font-semibold uppercase text-slate-500"
      >
        Assigned to
      </label>
      <select
        id="lead-assignment"
        value={currentAssignee ?? UNASSIGNED_VALUE}
        onChange={handleChange}
        disabled={saving}
        className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-900 focus:border-blue-500 focus:outline-none disabled:opacity-60"
      >
        <option value={UNASSIGNED_VALUE}>Unassigned</option>
        {members.map((member) => (
          <option key={member.id} value={member.id}>
            {member.name}
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

export default AssignmentControl;
