/**
 * Analytics & Insights.
 *
 * WHAT THIS SCREEN REFUSES TO DO. There is no money in this schema - no deal value, no pipeline
 * figure, no cost - so it never renders a currency. There is no stage-transition history and no
 * assignment history, so there is no funnel, no time-in-stage and no win rate. And because the
 * classifications live in current-state columns that are overwritten in place, they are
 * reported as of now and are never drawn against a date. The trend chart uses only fields that
 * are stamped once. Every one of those absences is stated on the screen rather than filled in
 * with something that looks like an answer.
 *
 * SIX REQUESTS, TWO EFFECTS. The five summary panels share one date range and are fetched
 * together so they can never disagree about the window they describe; a partial failure blanks
 * the lot rather than leaving four fresh panels beside one stale one. The reminders overview is
 * in that batch even though three of its four counts ignore the range, because its fourth -
 * completed - does not, and splitting it would let one panel describe two windows at once. The
 * attention list is fetched separately because it also pages, and re-pulling five aggregates to
 * turn a page would be wasteful and would make the summary flicker.
 *
 * NAVIGATION IS NOT THIS SCREEN'S JOB. Drilling into a card and opening a conversation are
 * handed up as callbacks, so the shell owns routing and this page stays renderable in a test
 * without one.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  downloadAttentionCsv,
  getAnalyticsAiPerformance,
  getAnalyticsAttention,
  getAnalyticsBreakdowns,
  getAnalyticsOverview,
  getAnalyticsReminders,
  getAnalyticsTrends,
} from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import AiPerformancePanel from '../components/analytics/AiPerformancePanel';
import { MicroLabel } from '../components/analytics/AnalyticsPrimitives';
import AttentionTable from '../components/analytics/AttentionTable';
import BreakdownsPanel from '../components/analytics/BreakdownsPanel';
import ClassificationPanel from '../components/analytics/ClassificationPanel';
import DateRangeControl from '../components/analytics/DateRangeControl';
import KpiGrid, { type DrillFilters } from '../components/analytics/KpiGrid';
import RemindersOverviewPanel from '../components/analytics/RemindersOverviewPanel';
import TrendsChart from '../components/analytics/TrendsChart';
import Spinner from '../components/Spinner';
import { type AuthValue } from '../components/types';
import type {
  AnalyticsAiPerformance,
  AnalyticsAttentionList,
  AnalyticsBreakdowns,
  AnalyticsOverview,
  AnalyticsQuery,
  AnalyticsReminders,
  AnalyticsTrends,
  DateRangePreset,
} from '../types/analytics';

const PAGE_SIZE = 25;

type Props = {
  /** Opens one conversation in the inbox. */
  onOpenConversation?: (conversationId: string) => void;
  /** Hands the inbox the exact filters the clicked number was computed under. */
  onDrillDown?: (filters: DrillFilters) => void;
};

const AnalyticsPage = ({ onOpenConversation, onDrillDown }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;

  const [preset, setPreset] = useState<DateRangePreset>('last_30_days');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [trends, setTrends] = useState<AnalyticsTrends | null>(null);
  const [performance, setPerformance] = useState<AnalyticsAiPerformance | null>(null);
  const [breakdowns, setBreakdowns] = useState<AnalyticsBreakdowns | null>(null);
  const [reminders, setReminders] = useState<AnalyticsReminders | null>(null);
  const [attention, setAttention] = useState<AnalyticsAttentionList | null>(null);

  const [loadingSummary, setLoadingSummary] = useState(true);
  const [loadingAttention, setLoadingAttention] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [skip, setSkip] = useState(0);
  // Bumped by Retry. Having the effects depend on it re-runs them without duplicating the
  // fetch logic into a second code path that could drift from the first.
  const [reloadToken, setReloadToken] = useState(0);

  // A custom range is only a range once BOTH ends exist and they are the right way round.
  // Firing a request on a half-typed date would return a window nobody asked for.
  const customReady = preset !== 'custom' || (fromDate !== '' && toDate !== '' && fromDate <= toDate);

  const query = useMemo<AnalyticsQuery>(
    () => (preset === 'custom' ? { preset, fromDate, toDate } : { preset }),
    [preset, fromDate, toDate],
  );

  useEffect(() => {
    if (!customReady) return;

    let cancelled = false;

    const run = async () => {
      setLoadingSummary(true);

      try {
        // In parallel: five reads of the same window, so they land as one consistent picture.
        const [
          overviewResponse,
          trendsResponse,
          performanceResponse,
          breakdownsResponse,
          remindersResponse,
        ] = await Promise.all([
          authedRequest((token) => getAnalyticsOverview({ token, query })),
          authedRequest((token) => getAnalyticsTrends({ token, query })),
          authedRequest((token) => getAnalyticsAiPerformance({ token, query })),
          authedRequest((token) => getAnalyticsBreakdowns({ token, query })),
          authedRequest((token) => getAnalyticsReminders({ token, query })),
        ]);

        if (cancelled) return;

        setOverview(overviewResponse?.data ?? null);
        setTrends(trendsResponse?.data ?? null);
        setPerformance(performanceResponse?.data ?? null);
        setBreakdowns(breakdownsResponse?.data ?? null);
        setReminders(remindersResponse?.data ?? null);
        setError(null);
      } catch (loadError: unknown) {
        if (cancelled) return;

        // Blanked rather than left stale: a panel showing last week's numbers under this
        // week's heading is worse than a panel showing nothing.
        setOverview(null);
        setTrends(null);
        setPerformance(null);
        setBreakdowns(null);
        setReminders(null);
        setError(loadError instanceof Error ? loadError.message : 'Unable to load analytics.');
      } finally {
        if (!cancelled) setLoadingSummary(false);
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [authedRequest, query, customReady, reloadToken]);

  useEffect(() => {
    if (!customReady) return;

    let cancelled = false;

    const run = async () => {
      setLoadingAttention(true);

      try {
        const response = await authedRequest((token) =>
          getAnalyticsAttention({ token, query, limit: PAGE_SIZE, skip }),
        );

        if (cancelled) return;

        setAttention(response?.data ?? null);
      } catch (loadError: unknown) {
        if (cancelled) return;

        setAttention(null);
        setError(loadError instanceof Error ? loadError.message : 'Unable to load analytics.');
      } finally {
        if (!cancelled) setLoadingAttention(false);
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [authedRequest, query, skip, customReady, reloadToken]);

  const changePreset = (next: DateRangePreset) => {
    setPreset(next);
    // Page 3 of the old window is not page 3 of the new one.
    setSkip(0);
  };

  const changeCustom = (nextFrom: string, nextTo: string) => {
    setFromDate(nextFrom);
    setToDate(nextTo);
    setSkip(0);
  };

  const exportCsv = useCallback(async () => {
    setExporting(true);
    setError(null);
    setNotice(null);

    try {
      const blob = await authedRequest((token) => downloadAttentionCsv({ token, query }));

      // jsdom and older embedded webviews have no object-URL support. Saying so beats a
      // silent no-op that looks like the download was blocked by the browser.
      if (typeof URL.createObjectURL !== 'function') {
        setError('This browser cannot download files directly.');
        return;
      }

      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');

      anchor.href = href;
      anchor.download = 'needs-attention.csv';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(href);
      setNotice('CSV downloaded.');
    } catch (exportError: unknown) {
      setError(exportError instanceof Error ? exportError.message : 'Could not export the CSV.');
    } finally {
      setExporting(false);
    }
  }, [authedRequest, query]);

  const range = overview?.range ?? trends?.range ?? attention?.range ?? null;
  const firstLoad = loadingSummary && overview === null;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-3 p-4 sm:p-6">
      <div>
        <h1 className="text-xl font-bold text-bone">Analytics &amp; Insights</h1>
        <p className="mt-1 text-sm text-muted">
          What came in, what the AI did about it, and what is still waiting on you. Every number
          carries its definition — press the ? beside it.
        </p>
      </div>

      <DateRangeControl
        preset={preset}
        fromDate={fromDate}
        toDate={toDate}
        resolved={range}
        onPresetChange={changePreset}
        onCustomChange={changeCustom}
      />

      {!customReady ? (
        <p className="rounded-[var(--m-radius-card)] border border-hairline bg-panel p-3 text-sm text-muted">
          Pick a start and an end date. The end cannot be before the start.
        </p>
      ) : null}

      {notice ? (
        <p
          role="status"
          className="rounded-[var(--m-radius-card)] border border-hairline bg-panel p-3 text-sm text-bone"
        >
          {notice}
        </p>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--m-radius-card)] border border-danger/40 bg-panel p-3"
        >
          <span className="text-sm text-danger">{error}</span>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setReloadToken((token) => token + 1);
            }}
            className="min-h-11 rounded-[var(--m-radius-card)] border border-hairline px-3 font-mono text-[0.6875rem] uppercase tracking-[0.06em] text-bone-dim transition-colors hover:border-key/40 hover:text-key sm:min-h-0 sm:py-1.5"
          >
            Retry
          </button>
        </div>
      ) : null}

      {firstLoad && customReady ? (
        <div className="py-10">
          <Spinner label="Loading analytics…" />
        </div>
      ) : (
        <>
          <KpiGrid overview={overview} onDrillDown={onDrillDown} />
          <ClassificationPanel overview={overview} onDrillDown={onDrillDown} />
          <TrendsChart trends={trends} />
          <AiPerformancePanel performance={performance} />
          <BreakdownsPanel breakdowns={breakdowns} />

          {/* Reminders sit beside the breakdowns rather than in the KPI row: three of its four
              numbers are "right now" and would be read as range-filtered up there. */}
          {/* `error` is handed down so the panel can say what actually went wrong in the space
              its numbers would have filled. Retrying stays with the page's own banner - five
              panels each offering their own Retry for one failed batch would be five buttons
              that all do the same thing. */}
          <RemindersOverviewPanel
            reminders={reminders}
            loading={loadingSummary}
            error={error}
            onOpenConversation={onOpenConversation}
          />

          <AttentionTable
            rows={attention?.rows ?? []}
            total={attention?.total ?? 0}
            limit={attention?.limit ?? PAGE_SIZE}
            skip={attention?.skip ?? skip}
            loading={loadingAttention}
            exporting={exporting}
            onPage={setSkip}
            onExport={() => void exportCsv()}
            onOpenConversation={onOpenConversation}
          />
        </>
      )}

      <div className="rounded-[var(--m-radius-card)] border border-hairline bg-panel p-3">
        <MicroLabel>How to read this</MicroLabel>
        <ul className="mt-1.5 space-y-1 text-[0.6875rem] leading-relaxed text-muted">
          <li>
            <span className="text-bone-dim">0</span> means it was counted and the answer was none.{' '}
            <span className="text-bone-dim">—</span> means there is no number to show, and the
            panel says why.
          </li>
          <li>
            Classification and AI status describe conversations{' '}
            <span className="text-bone-dim">as they stand now</span>. They are stored in fields
            that get overwritten, so they cannot be replayed over a date range.
          </li>
          <li>
            This system records no deal value, so there are no revenue, pipeline or
            cost-per-lead figures anywhere on this page.
          </li>
        </ul>
      </div>
    </div>
  );
};

export default AnalyticsPage;
