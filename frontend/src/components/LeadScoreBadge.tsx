import { getLeadScoreBandStyle } from '../lib/lead-score';

type Props = {
  band?: string | null;
  /** Shown alongside the band in the lead panel; left off in the inbox list, where the row is
   *  already carrying a stage, a preview and an unread count. */
  score?: number | null;
  showScore?: boolean;
};

/**
 * How warm a lead is, in one pill — the same shape and size as StageBadge next to it, so a row
 * that carries both reads as one line rather than two competing labels.
 *
 * Renders nothing for a lead nobody has scored yet (band absent, or the default low-intent zero):
 * an inbox where every row shouts "LOW INTENT" tells the owner nothing, and the point of the
 * badge is that a HOT lead is visible without opening it.
 */
const LeadScoreBadge = ({ band, score, showScore = false }: Props) => {
  if (!band || (band === 'low_intent' && !score)) {
    return null;
  }

  const style = getLeadScoreBandStyle(band);

  return (
    <span className={style.className} title={style.handling}>
      {style.label}
      {showScore && typeof score === 'number' ? ` · ${score}` : ''}
    </span>
  );
};

export default LeadScoreBadge;
