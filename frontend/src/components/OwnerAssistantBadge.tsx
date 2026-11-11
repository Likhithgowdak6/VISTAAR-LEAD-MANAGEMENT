type Props = {
  kind?: string | null;
};

/**
 * Marks the studio owner's own thread with the AI as internal.
 *
 * WHY A BADGE AND NOT A SEPARATE SCREEN. This conversation uses the same messages, the same
 * bubbles and the same composer as a customer thread, so a second interface would be a copy
 * that drifts. What it needs is one unmistakable signal that nobody is reading these words on
 * the other end except the owner — otherwise a teammate glancing at the Inbox sees "Owner
 * Assistant" at the top of the list and reasonably assumes it is a client called that.
 *
 * Renders nothing for a customer thread, which is every conversation that exists today:
 * `kind` is absent on all of them and is never backfilled.
 */
const OwnerAssistantBadge = ({ kind }: Props) => {
  if (kind !== 'owner_assistant') {
    return null;
  }

  return (
    <span
      // Not aria-hidden: "internal" is the whole meaning of the row and a screen-reader user
      // needs it as much as a sighted one. The icon beside it IS decorative and is hidden.
      aria-label="Internal assistant conversation"
      // Amber rather than the blue used for selection, so it reads as a property of the
      // conversation and not as a selected state. Both stops are chosen for 4.5:1 against
      // their own fill in light and dark mode respectively.
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[0.625rem] font-semibold uppercase tracking-wide text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-3 w-3"
      >
        <rect x="3" y="11" width="18" height="10" rx="2" />
        <circle cx="12" cy="5" r="2" />
        <path d="M12 7v4" />
        <path d="M8 16h.01" />
        <path d="M16 16h.01" />
      </svg>
      Internal
    </span>
  );
};

export default OwnerAssistantBadge;
