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
    {/* An empty screen is an invitation to act, so the title is set in the display face rather
        than whispered in body text - it reads as a slide with nothing on it yet, not an error. */}
    <p
      className={
        compact
          ? 'text-sm font-medium text-bone-dim'
          : 'font-display text-xl uppercase tracking-[0.14em] text-bone-dim'
      }
    >
      {title}
    </p>
    {description ? (
      <p className="mx-auto mt-1.5 max-w-xs text-sm leading-relaxed text-muted">{description}</p>
    ) : null}
  </div>
);

export default EmptyState;
