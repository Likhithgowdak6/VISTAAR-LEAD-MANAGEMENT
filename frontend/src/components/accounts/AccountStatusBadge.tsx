const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-slate-100 text-slate-600',
  connecting: 'bg-amber-100 text-amber-700',
  active: 'bg-green-100 text-green-700',
  reconnecting: 'bg-amber-100 text-amber-700',
  disconnected: 'bg-slate-200 text-slate-600',
  paused: 'bg-blue-100 text-blue-700',
  removed: 'bg-red-100 text-red-700',
  blocked: 'bg-red-100 text-red-700',
};

type Props = {
  status?: string | null;
};

const AccountStatusBadge = ({ status }: Props) => {
  if (!status) {
    return null;
  }

  const className = STATUS_STYLES[status] ?? 'bg-slate-100 text-slate-600';

  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${className}`}>
      {status}
    </span>
  );
};

export default AccountStatusBadge;
