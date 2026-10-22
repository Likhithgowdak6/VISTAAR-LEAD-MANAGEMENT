export type DateInput = string | number | Date | null | undefined;

export const formatRelativeTime = (value: DateInput, now: number = Date.now()): string => {
  if (!value) {
    return '';
  }

  const timestamp = new Date(value).getTime();

  if (Number.isNaN(timestamp)) {
    return '';
  }

  const diffSeconds = Math.round((now - timestamp) / 1000);

  if (diffSeconds < 45) {
    return 'just now';
  }

  const minutes = Math.round(diffSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.round(hours / 24);
  if (days < 7) {
    return `${days}d ago`;
  }

  return new Date(timestamp).toLocaleDateString();
};

export const formatClockTime = (value: DateInput): string => {
  if (!value) {
    return '';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

export const getInitials = (name: string | null | undefined): string => {
  if (!name) {
    return '?';
  }

  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
};

/**
 * A file size a person can read: "812 KB", "2.4 MB".
 *
 * Decimal units, not binary - a phone and an operating system both say 2.4 MB for the same file
 * that a `1024`-based count would call 2.3 MiB, and the number beside an attachment is there to
 * be compared with what the owner sees elsewhere, not to be exact.
 */
export const formatFileSize = (bytes: number | null | undefined): string | null => {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
    return null;
  }

  if (bytes < 1000) {
    return `${bytes} B`;
  }

  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1000;
  let unitIndex = 0;

  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000;
    unitIndex += 1;
  }

  // One decimal below 10 ("2.4 MB"), none above it ("812 KB") - the extra digit stops being
  // information once the number is large.
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unitIndex]}`;
};
