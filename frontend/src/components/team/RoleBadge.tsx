import { ROLE_LABELS } from '../../lib/permissions';

const ROLE_STYLES: Record<string, string> = {
  super_admin: 'bg-purple-50 text-purple-700',
  admin: 'bg-blue-50 text-blue-700',
  manager: 'bg-emerald-50 text-emerald-700',
  staff: 'bg-slate-100 text-slate-600',
};

type Props = {
  role: string;
};

const RoleBadge = ({ role }: Props) => {
  const roleLabels = ROLE_LABELS as Record<string, string>;

  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
        ROLE_STYLES[role] ?? ROLE_STYLES.staff
      }`}
    >
      {roleLabels[role] ?? role}
    </span>
  );
};

export default RoleBadge;
