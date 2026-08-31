import LeadScoreBadge from '../LeadScoreBadge';
import { getLeadScoreBandStyle, LEAD_SCORE_MAX, LEAD_SCORE_SIGNALS } from '../../lib/lead-score';

type Props = {
  /** 0-100. Absent on a conversation loaded from a build that predates scoring. */
  leadScore?: number | null;
  leadScoreBand?: string | null;
  /** The signal keys that fired. Everything else in LEAD_SCORE_SIGNALS is still missing. */
  leadScoreSignals?: readonly string[] | null;
};

/**
 * How warm this lead is, and — the part that matters — WHY.
 *
 * A score on its own is a number nobody trusts and nobody can act on. The breakdown is the
 * feature: the ticked signals say what this lead has already given us, and the unticked ones are
 * a to-do list of exactly what to ask next to move them up a band. Same bordered-card shape as
 * every other section in this panel.
 */
const LeadScoreSection = ({ leadScore, leadScoreBand, leadScoreSignals }: Props) => {
  const score = typeof leadScore === 'number' ? leadScore : 0;
  const fired = new Set(leadScoreSignals ?? []);
  // No band at all means nobody has scored this conversation yet, which is a 0 - and a 0 is
  // low intent by definition. Rendering it as such beats rendering it as a blank.
  const band = getLeadScoreBandStyle(leadScoreBand ?? 'low_intent');

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase text-slate-500">Lead score</span>
        <LeadScoreBadge band={leadScoreBand ?? 'low_intent'} score={score} showScore />
      </div>

      <p className="mt-1 text-sm font-medium text-slate-800">
        {score}
        <span className="text-slate-400">/{LEAD_SCORE_MAX}</span>
      </p>
      <p className="mt-0.5 text-xs text-slate-500">{band.handling}</p>

      <ul className="mt-2 space-y-1">
        {LEAD_SCORE_SIGNALS.map((signal) => {
          const hit = fired.has(signal.key);

          return (
            <li
              key={signal.key}
              className={`flex items-center justify-between gap-2 text-xs ${
                hit ? 'text-slate-700' : 'text-slate-400'
              }`}
            >
              <span>
                <span aria-hidden="true">{hit ? '✓' : '○'}</span> {signal.label}
              </span>
              <span className={hit ? 'font-semibold text-slate-700' : ''}>
                {hit ? `+${signal.points}` : `+${signal.points} if asked`}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default LeadScoreSection;
