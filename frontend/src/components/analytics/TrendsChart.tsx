/**
 * The only part of this screen that is allowed to have an x-axis.
 *
 * WHY ONLY THESE FOUR SERIES. A trend needs a field that is stamped once and never rewritten.
 * The classifications are not that - they are derived from current-state columns that are
 * overwritten in place, so "enquiries over time" computed from them would really be "today's
 * classification, back-dated", which is a graph of a lie. These four are bucketed on genuinely
 * dated fields (conversation creation, lead qualification, message send) and so can honestly
 * be drawn against a date.
 *
 * HAND-ROLLED, because the app has no chart library and adding one to draw four polylines
 * would be the largest dependency in the frontend. The drawing follows the console's house
 * idiom: the measurement is light, the grid is hairline, and nothing is coloured that is not
 * also distinguishable by its dash pattern.
 *
 * A SERIES THE SERVER DID NOT SEND IS NOT A FLAT ZERO LINE. It is dropped from the plot and
 * named in the legend as not reported. Drawing it along the bottom would assert that nothing
 * happened, which is a different and much more damaging claim than "we do not have this".
 */
import type { AnalyticsTrends, TrendPoint } from '../../types/analytics';

import { DASH } from './AnalyticsFormat';
import { Card, MicroLabel, NotShown } from './AnalyticsPrimitives';

type SeriesKey =
  | 'conversationsCreated'
  | 'enquiriesConfirmed'
  | 'inboundMessages'
  | 'outboundMessagesDelivered';

const SERIES: { key: SeriesKey; label: string; color: string; dash?: string }[] = [
  { key: 'conversationsCreated', label: 'Conversations created', color: 'var(--color-bone-dim)' },
  { key: 'enquiriesConfirmed', label: 'Enquiries confirmed', color: 'var(--color-key)' },
  {
    key: 'inboundMessages',
    label: 'Inbound messages',
    color: 'var(--color-fill)',
    dash: '4 3',
  },
  {
    key: 'outboundMessagesDelivered',
    label: 'Outbound delivered',
    color: 'var(--color-key-soft)',
    dash: '1 3',
  },
];

const WIDTH = 640;
const HEIGHT = 170;
const PAD_LEFT = 34;
const PAD_RIGHT = 8;
const PAD_TOP = 10;
const PAD_BOTTOM = 22;

/** Reads one series off a point. Typed through `unknown` because the wire may omit the key. */
const readSeries = (point: TrendPoint, key: SeriesKey): number | null => {
  const raw: unknown = point[key];

  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
};

const TrendsChart = ({ trends }: { trends: AnalyticsTrends | null }) => {
  const points = trends?.points ?? [];

  const available = SERIES.filter((series) =>
    points.some((point) => readSeries(point, series.key) !== null),
  );
  const missing = SERIES.filter((series) => !available.includes(series));

  const max = available.reduce((highest, series) => {
    const seriesMax = points.reduce((best, point) => {
      const value = readSeries(point, series.key);
      return value !== null && value > best ? value : best;
    }, 0);

    return Math.max(highest, seriesMax);
  }, 0);

  const plotWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;

  const xAt = (index: number) =>
    points.length <= 1 ? PAD_LEFT + plotWidth / 2 : PAD_LEFT + (index / (points.length - 1)) * plotWidth;
  const yAt = (value: number) => PAD_TOP + plotHeight - (max === 0 ? 0 : (value / max) * plotHeight);

  /** Breaks the line wherever a day is missing rather than bridging across the hole. */
  const pathFor = (key: SeriesKey) => {
    let path = '';
    let penDown = false;

    points.forEach((point, index) => {
      const value = readSeries(point, key);

      if (value === null) {
        penDown = false;
        return;
      }

      path += `${penDown ? 'L' : 'M'}${xAt(index).toFixed(1)} ${yAt(value).toFixed(1)} `;
      penDown = true;
    });

    return path.trim();
  };

  const totalFor = (key: SeriesKey) =>
    points.reduce((sum, point) => sum + (readSeries(point, key) ?? 0), 0);

  const everythingZero = available.length > 0 && max === 0;

  return (
    <Card>
      <div className="flex items-center justify-between gap-2">
        <MicroLabel>Trends</MicroLabel>
        <span className="font-mono text-[0.625rem] uppercase tracking-[0.06em] text-muted">
          By day
        </span>
      </div>

      {points.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">
          No days in this range yet.
        </p>
      ) : everythingZero ? (
        <p className="py-8 text-center text-sm text-muted">
          Nothing happened on any day in this range. Every series is zero.
        </p>
      ) : (
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Daily trend across ${points.length} days, peak ${max}`}
          className="mt-2 h-44 w-full"
        >
          {/* Three hairline gridlines and their values - enough to read a magnitude off,
              few enough that the lines stay the brightest thing in the frame. */}
          {[0, 0.5, 1].map((fraction) => {
            const y = PAD_TOP + plotHeight * (1 - fraction);

            return (
              <g key={fraction}>
                <line
                  x1={PAD_LEFT}
                  x2={WIDTH - PAD_RIGHT}
                  y1={y}
                  y2={y}
                  stroke="var(--color-hairline)"
                  strokeWidth={1}
                />
                <text
                  x={PAD_LEFT - 6}
                  y={y + 3}
                  textAnchor="end"
                  fill="var(--color-muted)"
                  fontSize={9}
                  fontFamily="var(--font-mono)"
                >
                  {Math.round(max * fraction)}
                </text>
              </g>
            );
          })}

          {available.map((series) => (
            <path
              key={series.key}
              d={pathFor(series.key)}
              fill="none"
              stroke={series.color}
              strokeWidth={1.75}
              strokeDasharray={series.dash}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {/* First and last day, so the axis is anchored without crowding it with labels. */}
          <text
            x={PAD_LEFT}
            y={HEIGHT - 6}
            fill="var(--color-muted)"
            fontSize={9}
            fontFamily="var(--font-mono)"
          >
            {points[0]?.day}
          </text>
          <text
            x={WIDTH - PAD_RIGHT}
            y={HEIGHT - 6}
            textAnchor="end"
            fill="var(--color-muted)"
            fontSize={9}
            fontFamily="var(--font-mono)"
          >
            {points[points.length - 1]?.day}
          </text>
        </svg>
      )}

      <ul className="mt-2 grid gap-1 sm:grid-cols-2">
        {SERIES.map((series) => {
          const isAvailable = available.includes(series);

          return (
            <li
              key={series.key}
              className="flex items-center justify-between gap-2 text-[0.6875rem]"
              title={trends?.definitions?.[series.key]}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="h-0.5 w-4 shrink-0 rounded-full"
                  style={{
                    background: isAvailable ? series.color : 'var(--color-hairline)',
                  }}
                />
                <span className={`truncate ${isAvailable ? 'text-bone-dim' : 'text-muted'}`}>
                  {series.label}
                </span>
              </span>
              <span
                className={`font-mono tabular-nums ${isAvailable ? 'text-bone' : 'text-muted'}`}
                data-unknown={isAvailable ? 'false' : 'true'}
              >
                {isAvailable ? totalFor(series.key).toLocaleString() : DASH}
              </span>
            </li>
          );
        })}
      </ul>

      {missing.length > 0 ? (
        <NotShown>
          Not plotted, because the server did not return{' '}
          {missing.map((series) => series.key).join(', ')} on any day in this range. These are
          absent, not zero.
        </NotShown>
      ) : null}
    </Card>
  );
};

export default TrendsChart;
