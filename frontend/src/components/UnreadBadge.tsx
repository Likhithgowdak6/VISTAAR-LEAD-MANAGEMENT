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
      className="inline-flex min-w-5 items-center justify-center rounded-full bg-green-500 px-1.5 text-xs font-semibold text-white"
    >
      {count > 99 ? '99+' : count}
    </span>
  );
};

export default UnreadBadge;
