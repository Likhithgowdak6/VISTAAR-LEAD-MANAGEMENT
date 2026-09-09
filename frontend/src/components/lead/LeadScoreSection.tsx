import LeadScoreBadge from '../LeadScoreBadge';
import {
  getLeadScoreBandStyle,
  LEAD_SCORE_BAND_STOPS,
  LEAD_SCORE_MAX,
  LEAD_SCORE_SIGNALS,
} from '../../lib/lead-score';

type Props = {
  /** 0-100. Absent on a conversation loaded from a build that predates scoring. */
  leadScore?: number | null;
  leadScoreBand?: string | null;
  /** The signal keys that fired. Everything else in LEAD_SCORE_SIGNALS is still missing. */
  leadScoreSignals?: readonly string[] | null;
};

/**
 * How warm this lead is, and - the part that matters - WHY.
 *
 * Drawn as an EXPOSURE METER, because that is the instrument this business already reads. A lead
 * with nothing known is an underexposed frame; one that has given us a date, a venue and a budget
 * is properly lit. The scale carries the band thresholds as labelled stops, so the owner can see
 * not only where the lead sits but how far it is from the next band - which a bare percentage bar
 * cannot say.
 *
 * The glow is the reading, not an effect: its intensity is derived from the score, so a hot lead
 * is literally the brightest thing in the panel and an unscored one emits nothing at all.
 *
 * Under the meter, the breakdown stays as it was, because it is the actionable half: the ticked
 * signals are what this lead has told us, and the unticked ones are exactly what to ask next.
 */
const LeadScoreSection = ({ leadScore, leadScoreBand, leadScoreSignals }: Props) => {
  const score = typeof leadScore === 'number' ? leadScore : 0;
  const fired = new Set(leadScoreSignals ?? []);
  // No band at all means nobody has scored this conversation yet, which is a 0 - and a 0 is
  // low intent by definition. Rendering it as such beats rendering it as a blank.
  const band = getLeadScoreBandStyle(leadScoreBand ?? 'low_intent');

  const exposed = Math.max(0, Math.min(100, score)) / LEAD_SCORE_MAX;
  // 0 at the bottom of the scale, 1 at the top. Kept off zero once there is any score at all,
  // so a lead on 20 still reads as emitting a little light rather than as switched off.
  const intensity = exposed === 0 ? 0 : 0.25 + exposed * 0.75;

  return (
    <div className="surface rounded-lg p-3">
      <div className="flex items-center justify-between">
        {/* "Lead score" and not "Exposure": the meter below is the metaphor, but the label has to
            be the thing the owner already calls it - and what every other screen calls it too. */}
        <span className="eyebrow">Lead score</span>
        <LeadScoreBadge band={leadScoreBand ?? 'low_intent'} score={score} showScore />
      </div>

      {/* ---- The meter ---------------------------------------------------- */}
      <div className="mt-3">
        <div className="relative h-8">
          {/* The stop scale: hairline ticks at each band threshold. */}
          <div className="absolute inset-x-0 top-0 flex justify-between">
            {LEAD_SCORE_BAND_STOPS.map((stop) => (
              <span
                key={stop.label}
                className="font-mono text-[0.5625rem] uppercase tracking-[0.08em] text-muted"
              >
                {stop.label}
              </span>
            ))}
          </div>

          {/* The track. Ticks are drawn into the background so they cannot drift out of
              alignment with the fill above them. */}
          <div
            className="absolute inset-x-0 bottom-1 h-1.5 overflow-hidden rounded-full border border-hairline bg-ink"
            style={{
              backgroundImage:
                'repeating-linear-gradient(90deg, rgb(255 255 255 / 8%) 0 1px, transparent 1px 10%)',
            }}
          >
            {/* The exposed portion, graded cool -> warm across the scale: an underexposed frame
                sits in the fill light, a properly lit one in the key. */}
            <div
              className="h-full rounded-full transition-[width] duration-500 ease-out"
              style={{
                width: `${exposed * 100}%`,
                background: 'linear-gradient(90deg, var(--color-fill-deep), var(--color-key))',
                opacity: 0.9,
              }}
            />
          </div>

          {/* The indicator: the meter's needle, glowing in proportion to the reading. */}
          <div
            aria-hidden="true"
            className="absolute bottom-0 h-3.5 w-[3px] -translate-x-1/2 rounded-full bg-key transition-[left] duration-500 ease-out"
            style={{
              left: `${exposed * 100}%`,
              boxShadow: `0 0 ${6 + intensity * 12}px ${intensity * 2}px rgb(255 158 74 / ${Math.round(
                intensity * 75,
              )}%)`,
              opacity: exposed === 0 ? 0.3 : 1,
            }}
          />
        </div>

        <p className="mt-1.5 flex items-baseline justify-between gap-2">
          <output className="text-sm font-semibold text-bone">
            {score}
            <span className="text-muted">/{LEAD_SCORE_MAX}</span>
          </output>
          <span className="text-[0.6875rem] text-bone-dim">{band.handling}</span>
        </p>
      </div>

      {/* ---- Why ---------------------------------------------------------- */}
      <ul className="mt-3 space-y-1 border-t border-hairline pt-2.5">
        {LEAD_SCORE_SIGNALS.map((signal) => {
          const hit = fired.has(signal.key);

          return (
            <li
              key={signal.key}
              className={`flex items-center justify-between gap-2 text-xs ${
                hit ? 'text-bone-dim' : 'text-muted'
              }`}
            >
              {/* The tick stays a character rather than becoming a coloured dot: it survives
                  a screen reader, and it is the difference between "fired" and "still to ask"
                  being readable without relying on colour. Lit type, not a lit pip. */}
              <span>
                <span
                  className={hit ? 'text-key [text-shadow:0_0_8px_rgb(255_158_74/70%)]' : ''}
                  aria-hidden="true"
                >
                  {hit ? '✓' : '○'}
                </span>{' '}
                {signal.label}
              </span>
              <span
                className={`font-mono text-[0.6875rem] ${hit ? 'text-key-soft' : 'text-muted'}`}
              >
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
