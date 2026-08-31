// `compact` drops the full-bleed centering (h-full + justify-center) used for a standalone
// empty screen, so it can sit inline after other content (e.g. a sidebar section) without
// its height stretching past its own text and overlapping whatever comes next.
type Props = {
  title: string;
  description?: string;
  compact?: boolean;
};

const EmptyState = ({ title, description, compact = false }: Props) => (
  <div
    className={
      compact
        ? 'py-4 text-center'
        : 'flex h-full flex-col items-center justify-center p-8 text-center'
    }
  >
    <p
      className={
        compact ? 'text-sm font-medium text-slate-600' : 'text-base font-semibold text-slate-700'
      }
    >
      {title}
    </p>
    {description ? <p className="mt-1 text-sm text-slate-500">{description}</p> : null}
  </div>
);

export default EmptyState;
