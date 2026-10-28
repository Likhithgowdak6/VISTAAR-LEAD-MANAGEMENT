import { PULL_TO_REFRESH_THRESHOLD_PX } from '../hooks/usePullToRefresh';

interface Props {
  /** Spacer height in pixels, straight from the hook. */
  distance: number;
  /** Past the threshold - the pull will fire when the finger lifts. */
  armed: boolean;
  /** The refetch is in flight. */
  refreshing: boolean;
}

/**
 * The thing that opens above a list while it is pulled.
 *
 * A SPACER, NOT AN OVERLAY. Its height grows with the drag, so the list moves down the way
 * the finger does and the indicator sits in the gap. Transforming the list instead would mean
 * fighting the scroll container's own geometry, and an absolutely-positioned overlay would
 * cover the first row rather than revealing space above it.
 *
 * NO TRANSITION WHILE DRAGGING. A CSS transition is what makes the spring-back feel like one,
 * but applying it during the drag puts the spacer permanently behind the finger. So it is
 * enabled only when the finger is up - which is exactly when `refreshing` is false and the
 * distance is being driven back to zero.
 *
 * `aria-hidden` while idle, because an empty zero-height box announcing itself on every screen
 * reader pass is noise. Once it is doing something it becomes a live status.
 */
const PullToRefreshIndicator = ({ distance, armed, refreshing }: Props) => {
  const idle = distance === 0 && !refreshing;
  const height = refreshing ? PULL_TO_REFRESH_THRESHOLD_PX : distance;

  return (
    <div
      data-testid="pull-to-refresh-indicator"
      aria-hidden={idle}
      role={idle ? undefined : 'status'}
      aria-live="polite"
      style={{
        height: `${height}px`,
        // Only springs back; follows the finger exactly while pulling.
        transition: refreshing || distance > 0 ? 'none' : 'height 200ms ease-out',
      }}
      className="flex items-center justify-center overflow-hidden"
    >
      {idle ? null : (
        <span className="flex items-center gap-2 text-xs text-muted">
          <span
            // Spins only while fetching. During the drag it rotates with the pull, which is
            // what tells the user the gesture is being received at all.
            className={`inline-block h-4 w-4 rounded-full border-2 border-hairline border-t-key ${
              refreshing ? 'animate-spin' : ''
            }`}
            style={
              refreshing ? undefined : { transform: `rotate(${Math.min(distance * 3, 360)}deg)` }
            }
          />
          {refreshing ? 'Refreshing…' : armed ? 'Release to refresh' : 'Pull to refresh'}
        </span>
      )}
    </div>
  );
};

export default PullToRefreshIndicator;
