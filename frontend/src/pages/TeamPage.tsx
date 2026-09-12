import { useCallback, useEffect, useState } from 'react';

import { listUsers } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import EmptyState from '../components/EmptyState';
import Spinner from '../components/Spinner';
import AddUserForm from '../components/team/AddUserForm';
import UserRow from '../components/team/UserRow';
import { type TeamMember } from '../components/types';
import { hasPermission, PERMISSIONS } from '../lib/permissions';

const TeamPage = () => {
  const { authedRequest, permissions, user } = useAuth();
  const [users, setUsers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const canManage = hasPermission(permissions, PERMISSIONS.USERS_MANAGE);

  const load = useCallback(async () => {
    try {
      const payload = await authedRequest((token) => listUsers({ token }));
      setUsers(payload.data ?? []);
      setError(null);
    } catch (loadError: unknown) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load team members.');
    } finally {
      setLoading(false);
    }
  }, [authedRequest]);

  useEffect(() => {
    // Fetch-on-mount: state updates happen after the awaited request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
      <div>
        <h1 className="text-xl font-bold text-slate-900">Team</h1>
        <p className="mt-1 text-sm text-slate-500">
          Admins manage numbers and people. Managers see every conversation. Staff only see the
          conversations assigned to them.
        </p>
      </div>

      {canManage ? <AddUserForm onCreated={load} /> : null}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        {loading ? (
          <div className="p-4">
            <Spinner label="Loading team…" />
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="p-4 text-sm text-red-600">
            {error}
          </p>
        ) : null}
        {!loading && users.length === 0 ? (
          <EmptyState title="No team members yet" description="Add your first teammate above." />
        ) : null}
        <ul>
          {users.map((teamMember) => (
            <UserRow
              key={teamMember.id}
              user={teamMember}
              currentUserId={user?.id}
              onChanged={load}
            />
          ))}
        </ul>
      </div>
    </div>
  );
};

export default TeamPage;
