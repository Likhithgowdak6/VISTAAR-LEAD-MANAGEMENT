/**
 * The two partitions: what each conversation IS, and where its AI reply stands.
 *
 * Both groups are rendered from a fixed list of the canonical values rather than from whatever
 * the server happened to send. That is the whole point of this panel. If the backend stops
 * emitting a bucket - a new status is added, a pipeline stage is skipped, a query regresses -
 * iterating the response would make the bucket silently disappear and the remaining ones would
 * look like the complete picture. Iterating the canonical list instead leaves a visible hole:
 * the bucket is listed, and its value is a dash, which reads as "we were not told" and not as
 * "none". A zero that the server DID send still renders as a real 0.
 *
 * AS OF NOW, NOT OVER THE RANGE. Both classifications are derived from current-state fields
 * that are overwritten in place, so they describe the conversations in the window as they stand
 * at this moment. They cannot be trended, and the caption says so rather than leaving a reader
 * to assume the date filter did something it did not.
 */
import type { AiResponseStatus, AnalyticsOverview, EnquiryClass } from '../../types/analytics';

import {
  AI_STATUS_DEFINITIONS,
  AI_STATUS_LABELS,
  AI_STATUS_ORDER,
  ENQUIRY_CLASS_DEFINITIONS,
  ENQUIRY_CLASS_LABELS,
  ENQUIRY_CLASS_ORDER,
} from './AnalyticsFormat';
import { Card, CountChip, MicroLabel, NotShown } from './AnalyticsPrimitives';
import type { DrillFilters } from './KpiGrid';

type Props = {
  overview: AnalyticsOverview | null;
  onDrillDown?: (filters: DrillFilters) => void;
};

const ClassificationPanel = ({ overview, onDrillDown }: Props) => {
  // Maps, not array scans, so a duplicated bucket in the payload cannot shadow another.
  const classCounts = new Map<EnquiryClass, number>(
    (overview?.enquiryClassCounts ?? []).map((entry) => [entry.enquiryClass, entry.count]),
  );
  const statusCounts = new Map<AiResponseStatus, number>(
    (overview?.aiStatusCounts ?? []).map((entry) => [entry.status, entry.count]),
  );

  const anyStatusMissing = AI_STATUS_ORDER.some((status) => !statusCounts.has(status));
  const anyClassMissing = ENQUIRY_CLASS_ORDER.some((value) => !classCounts.has(value));

  return (
    <div className="grid gap-2 lg:grid-cols-2">
      <Card>
        <div className="flex items-center justify-between gap-2">
          <MicroLabel>Enquiry classification</MicroLabel>
          <span className="font-mono text-[0.625rem] uppercase tracking-[0.06em] text-muted">
            As of now
          </span>
        </div>

        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {ENQUIRY_CLASS_ORDER.map((value) => (
            <CountChip
              key={value}
              label={ENQUIRY_CLASS_LABELS[value]}
              bucketId={`enquiry-class:${value}`}
              definition={ENQUIRY_CLASS_DEFINITIONS[value]}
              value={classCounts.get(value) ?? null}
              onClick={onDrillDown ? () => onDrillDown({ enquiryClass: value }) : undefined}
            />
          ))}
        </div>

        {anyClassMissing ? (
          <NotShown>
            A dash means the server did not report that class in this response — it is not a zero.
          </NotShown>
        ) : null}
      </Card>

      <Card>
        <div className="flex items-center justify-between gap-2">
          <MicroLabel>AI response status</MicroLabel>
          <span className="font-mono text-[0.625rem] uppercase tracking-[0.06em] text-muted">
            As of now
          </span>
        </div>

        <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {AI_STATUS_ORDER.map((status) => (
            <CountChip
              key={status}
              label={AI_STATUS_LABELS[status]}
              bucketId={`ai-status:${status}`}
              definition={AI_STATUS_DEFINITIONS[status]}
              value={statusCounts.get(status) ?? null}
              tone={status === 'awaiting_ai_reply' || status === 'ai_reply_failed' ? 'key' : 'neutral'}
              onClick={onDrillDown ? () => onDrillDown({ aiStatus: status }) : undefined}
            />
          ))}
        </div>

        {anyStatusMissing ? (
          <NotShown>
            A dash means the server did not report that bucket in this response — it is not a zero.
          </NotShown>
        ) : null}
      </Card>
    </div>
  );
};

export default ClassificationPanel;
