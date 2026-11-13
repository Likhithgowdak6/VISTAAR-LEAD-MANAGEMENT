/**
 * The "you are asking too fast" state.
 *
 * DELIBERATELY NOT RED. A rate limit is not a failure — nothing broke, the question was fine,
 * and the person has simply reached a budget. Rendering it in the same red box as a network
 * error tells them the feature is broken, and the reasonable response to a broken feature is to
 * try again immediately, which is precisely the behaviour the limit exists to stop.
 *
 * The countdown exists for the same reason. "Try again later" leaves someone clicking every few
 * seconds to find out when later is; a number that visibly decreases turns the wait into a known
 * quantity and the clicking stops.
 */
import { useEffect, useState } from 'react';

export interface AssistantRateLimitProps {
  message: string;
  retryAfterSeconds: number;
}

const format = (seconds: number) => {
  if (seconds >= 60) {
    const minutes = Math.ceil(seconds / 60);

    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }

  return `${seconds} second${seconds === 1 ? '' : 's'}`;
};

const AssistantRateLimit = ({ message, retryAfterSeconds }: AssistantRateLimitProps) => {
  const [remaining, setRemaining] = useState(retryAfterSeconds);

  useEffect(() => {
    setRemaining(retryAfterSeconds);
  }, [retryAfterSeconds]);

  useEffect(() => {
    if (remaining <= 0) {
      return;
    }

    const timer = window.setTimeout(() => setRemaining((value) => value - 1), 1000);

    // Cleared on unmount: a timer left running on a page the user has navigated away from
    // keeps setting state on a component that no longer exists.
    return () => window.clearTimeout(timer);
  }, [remaining]);

  return (
    <div
      role="status"
      className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="mt-0.5 h-4 w-4 shrink-0"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <circle cx="12" cy="12" r="9" />
        <path strokeLinecap="round" d="M12 7v5l3 2" />
      </svg>

      <div className="min-w-0">
        <p className="font-medium">{message}</p>

        {remaining > 0 ? (
          <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-300/80">
            You can ask again in about {format(remaining)}.
          </p>
        ) : (
          <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-300/80">
            You can try again now.
          </p>
        )}
      </div>
    </div>
  );
};

export default AssistantRateLimit;
