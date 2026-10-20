import { useState, type ReactNode } from 'react';

interface Props {
  title: string;
  /** A word or two of what is inside, so the row is useful while still closed. */
  hint?: ReactNode;
  /** Open on mount. For the one or two groups worth reading before anything is tapped. */
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * A collapsed group of lead-panel sections.
 *
 * WHY THE LEAD SCREEN NEEDED THIS. The panel renders thirteen sections - stage, service, event
 * date, score, AI assistant, templates, assignment, phone, form answers, tags, notes,
 * follow-ups, activity, delete. Side by side with the thread on a desktop that is a reference
 * column you glance down. Alone on a phone it is a single scroll about two thousand pixels
 * long, and the things reached for most often - the number, the stage, a template to send -
 * are scattered through it.
 *
 * Grouping does not remove anything. Every section is still present and still does what it
 * did; the ones you need while actually talking to someone are open, and the rest are one tap
 * away instead of twelve swipes.
 *
 * `<details>`/`<summary>` rather than a div and a boolean: the open/closed state, the role and
 * the keyboard behaviour are the element's own, it is findable by in-page search even while
 * collapsed, and it degrades to plain visible content if the CSS never loads.
 */
const MobileDisclosure = ({ title, hint, defaultOpen = false, children }: Props) => {
  // Mirrored into state only to rotate the chevron; `<details>` remains the source of truth.
  const [open, setOpen] = useState(defaultOpen);

  return (
    <details
      open={defaultOpen}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
      className="overflow-hidden rounded-[var(--m-radius-card)] border border-hairline bg-panel"
    >
      <summary className="flex min-h-[var(--m-tap)] cursor-pointer list-none items-center gap-2 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
        <span className="flex-1 text-sm font-semibold text-bone">{title}</span>
        {hint ? <span className="truncate text-xs text-muted">{hint}</span> : null}
        <svg
          viewBox="0 0 20 20"
          aria-hidden="true"
          className={`h-4 w-4 shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
        >
          <path
            d="m5.5 8 4.5 4.5L14.5 8"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </summary>
      <div className="flex flex-col gap-5 border-t border-hairline p-3">{children}</div>
    </details>
  );
};

export default MobileDisclosure;
