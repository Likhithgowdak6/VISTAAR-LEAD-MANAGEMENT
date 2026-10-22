/**
 * The small shapes the analytics screen is built from.
 *
 * Everything reads from the console's existing tokens rather than raw Tailwind colours: the
 * micro-label, the card and the chip are the same three shapes the lead panel is built from.
 *
 * The zero-versus-absence rule these render is defined in AnalyticsFormat; what matters here is
 * that an absent value is also styled differently (`text-muted`, `data-unknown="true"`), so the
 * distinction survives being scanned rather than read.
 */
import { useId, useState } from 'react';

import { DASH, formatCount } from './AnalyticsFormat';

/** The console's section label: condensed mono caps, used to title a region without shouting. */
export const MicroLabel = ({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) => (
  <span
    className={`font-mono text-[0.6875rem] uppercase tracking-[0.06em] text-muted ${className}`}
  >
    {children}
  </span>
);

/** The card every panel on this screen is built from. */
export const Card = ({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) => (
  <div className={`rounded-[var(--m-radius-card)] border border-hairline bg-panel p-3 ${className}`}>
    {children}
  </div>
);

/**
 * The "?" that makes a number mean something.
 *
 * `title` carries the definition for a mouse, and the toggle reveals it as real text for a
 * finger - a tooltip that only exists on hover is a tooltip a phone can never read. The button
 * is a sibling of the card's own click target rather than a child of it, because nesting a
 * button inside a button is invalid markup and the inner one stops being reachable.
 */
export const DefinitionTip = ({ text, label }: { text: string; label: string }) => {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`What "${label}" counts`}
        title={text}
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-mono text-[0.625rem] transition-colors ${
          open
            ? 'border-key/40 bg-key/10 text-key'
            : 'border-hairline text-muted hover:border-key/40 hover:text-key'
        }`}
      >
        ?
      </button>
      {open ? (
        <p
          id={panelId}
          className="col-span-full mt-2 border-t border-hairline pt-2 text-[0.6875rem] leading-relaxed text-bone-dim"
        >
          {text}
        </p>
      ) : null}
    </>
  );
};

/**
 * A number drawn large, with the dash drawn differently.
 *
 * An absent value is set in `text-muted` rather than `text-bone` so that scanning the grid, the
 * eye separates "nothing happened" from "we were not told" before reading a single word.
 */
export const StatValue = ({ text, className = '' }: { text: string; className?: string }) => (
  <span
    className={`text-2xl font-semibold tabular-nums ${
      text === DASH ? 'text-muted' : 'text-bone'
    } ${className}`}
    data-unknown={text === DASH ? 'true' : 'false'}
  >
    {text}
  </span>
);

/** A labelled count in a row - the chip idiom, used for the class and bucket strips. */
export const CountChip = ({
  label,
  bucketId,
  definition,
  value,
  onClick,
  tone = 'neutral',
}: {
  label: string;
  /**
   * A stable `group:value` identifier, e.g. `ai-status:needs_review`. Not the label: three
   * different buckets across the two partitions are all called "Needs review", so labels do
   * not identify a chip uniquely in the DOM.
   */
  bucketId: string;
  definition: string;
  value: number | null;
  onClick?: () => void;
  tone?: 'neutral' | 'key';
}) => {
  const text = formatCount(value);
  const body = (
    <>
      <span className="font-mono text-[0.6875rem] uppercase tracking-[0.06em] text-muted">
        {label}
      </span>
      <span
        className={`text-lg font-semibold tabular-nums ${
          text === DASH ? 'text-muted' : tone === 'key' ? 'text-key' : 'text-bone'
        }`}
        data-unknown={text === DASH ? 'true' : 'false'}
      >
        {text}
      </span>
    </>
  );

  const shared =
    'flex min-h-11 flex-col justify-center gap-0.5 rounded-[var(--m-radius-card)] border border-hairline bg-ink px-3 py-2 text-left';

  return onClick ? (
    <button
      type="button"
      data-bucket={bucketId}
      onClick={onClick}
      title={definition}
      className={`${shared} transition-colors hover:border-key/40 hover:text-key`}
    >
      {body}
    </button>
  ) : (
    <div data-bucket={bucketId} className={shared} title={definition}>
      {body}
    </div>
  );
};

/**
 * The quiet note that says a number is deliberately absent.
 *
 * Styled as information rather than as an error, because "this schema cannot answer that" is a
 * finding the owner should trust, not a failure the screen should apologise for.
 */
export const NotShown = ({ children }: { children: React.ReactNode }) => (
  <p className="text-[0.6875rem] leading-relaxed text-muted">{children}</p>
);
