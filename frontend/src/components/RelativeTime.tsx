import { formatRelativeTime } from '../lib/format';

type Props = {
  value?: string | null;
  className?: string;
};

const RelativeTime = ({ value, className }: Props) => {
  if (!value) {
    return null;
  }

  return (
    <time dateTime={value} className={className}>
      {formatRelativeTime(value)}
    </time>
  );
};

export default RelativeTime;
