type Props = {
  count?: number | null;
};

const UnreadBadge = ({ count }: Props) => {
  if (!count) {
    return null;
  }

  return (
    <span
      aria-label={`${count} unread`}
      className="glow-fill inline-flex min-w-5 items-center justify-center rounded-full bg-fill px-1.5 font-mono text-[0.625rem] font-semibold text-ink"
    >
      {count > 99 ? '99+' : count}
    </span>
  );
};

export default UnreadBadge;
