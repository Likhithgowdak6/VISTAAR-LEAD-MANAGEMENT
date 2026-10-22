/**
 * How the AI is doing - told as two separate stories, in two separate boxes.
 *
 * THE SEPARATION IS THE DESIGN. One conversation can carry twenty AI messages, so a
 * conversation count and a message count are counts of different objects. Put them in one row
 * of identical cards and somebody will add them together, or read "18 delivered" as eighteen
 * customers when it was three customers and a lot of back-and-forth. They are therefore given
 * their own headed sub-panels, their own unit stated in the heading, and a rule between them.
 *
 * First response time is reported with its sample size attached, because a median over two
 * conversations is an anecdote. When the server cannot compute it the value is null and prints
 * as a dash - a zero there would claim instant replies.
 */
import type { AnalyticsAiPerformance, DefinedCount } from '../../types/analytics';

import {
  countValue,
  DASH,
  formatCount,
  formatRate,
  formatSeconds,
  formatWorking,
} from './AnalyticsFormat';
import { Card, MicroLabel } from './AnalyticsPrimitives';

const Figure = ({ label, count }: { label: string; count: DefinedCount | undefined }) => {
  const text = formatCount(countValue(count));

  return (
    <div
      className="flex min-h-11 flex-col justify-center rounded-[var(--m-radius-card)] border border-hairline bg-ink px-3 py-2"
      title={count?.definition}
    >
      <span className="font-mono text-[0.6875rem] uppercase tracking-[0.06em] text-muted">
        {label}
      </span>
      <span
        className={`text-lg font-semibold tabular-nums ${text === DASH ? 'text-muted' : 'text-bone'}`}
        data-unknown={text === DASH ? 'true' : 'false'}
      >
        {text}
      </span>
    </div>
  );
};

const AiPerformancePanel = ({ performance }: { performance: AnalyticsAiPerformance | null }) => {
  const first = performance?.firstResponseSeconds;

  return (
    <Card>
      <MicroLabel>AI performance</MicroLabel>

      <div className="mt-2 grid gap-2 lg:grid-cols-2">
        {/* ---- Conversation-level ------------------------------------------ */}
        <section className="rounded-[var(--m-radius-card)] border border-hairline p-2.5">
          <h3 className="font-mono text-[0.6875rem] uppercase tracking-[0.06em] text-bone-dim">
            Counted in conversations
          </h3>

          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            <Figure label="With AI reply" count={performance?.enquiriesWithAiReply} />
            <Figure label="Awaiting reply" count={performance?.enquiriesAwaitingReply} />
            <Figure label="Paused / owner" count={performance?.pausedOrOwnerHandled} />
          </div>

          <div
            className="mt-2 flex items-baseline justify-between gap-2 border-t border-hairline pt-2"
            title={performance?.coverageRate?.definition}
          >
            <span className="font-mono text-[0.6875rem] uppercase tracking-[0.06em] text-muted">
              Coverage
            </span>
            <span className="flex items-baseline gap-2">
              <span className="font-mono text-[0.6875rem] text-bone-dim">
                {formatWorking(performance?.coverageRate)}
              </span>
              <span
                className={`text-lg font-semibold tabular-nums ${
                  formatRate(performance?.coverageRate) === DASH ? 'text-muted' : 'text-key'
                }`}
                data-unknown={formatRate(performance?.coverageRate) === DASH ? 'true' : 'false'}
              >
                {formatRate(performance?.coverageRate)}
              </span>
            </span>
          </div>
        </section>

        {/* ---- Message-level ----------------------------------------------- */}
        <section className="rounded-[var(--m-radius-card)] border border-hairline p-2.5">
          <h3 className="font-mono text-[0.6875rem] uppercase tracking-[0.06em] text-bone-dim">
            Counted in messages
          </h3>

          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            <Figure label="Delivered" count={performance?.aiMessagesDelivered} />
            <Figure label="Failed" count={performance?.aiMessagesFailed} />
            <Figure label="Pending" count={performance?.aiMessagesPending} />
          </div>

          <p className="mt-2 border-t border-hairline pt-2 text-[0.6875rem] leading-relaxed text-muted">
            One conversation can carry many AI messages. These do not add up with the
            conversation counts beside them.
          </p>
        </section>
      </div>

      {/* ---- First response ------------------------------------------------ */}
      <div
        className="mt-2 flex flex-wrap items-baseline gap-x-5 gap-y-1 rounded-[var(--m-radius-card)] border border-hairline bg-ink px-3 py-2"
        title={first?.definition}
      >
        <span className="font-mono text-[0.6875rem] uppercase tracking-[0.06em] text-muted">
          First AI response
        </span>
        <span className="text-sm text-bone-dim">
          median{' '}
          <span
            className={`font-semibold tabular-nums ${
              formatSeconds(first?.median) === DASH ? 'text-muted' : 'text-bone'
            }`}
            data-unknown={formatSeconds(first?.median) === DASH ? 'true' : 'false'}
          >
            {formatSeconds(first?.median)}
          </span>
        </span>
        <span className="text-sm text-bone-dim">
          mean{' '}
          <span
            className={`font-semibold tabular-nums ${
              formatSeconds(first?.average) === DASH ? 'text-muted' : 'text-bone'
            }`}
            data-unknown={formatSeconds(first?.average) === DASH ? 'true' : 'false'}
          >
            {formatSeconds(first?.average)}
          </span>
        </span>
        {/* The sample size is not decoration: a median over three threads is an anecdote. */}
        <span className="font-mono text-[0.6875rem] text-muted">
          n = {formatCount(first?.sampleSize)}
        </span>
      </div>
    </Card>
  );
};

export default AiPerformancePanel;
