type Props = {
  label?: string;
};

const Spinner = ({ label = 'Loading…' }: Props) => (
  <div role="status" className="flex items-center gap-2 text-sm text-slate-500">
    <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-blue-500" />
    {label}
  </div>
);

export default Spinner;
