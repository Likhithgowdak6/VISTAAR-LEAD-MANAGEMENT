type Props = {
  label?: string;
};

const Spinner = ({ label = 'Loading…' }: Props) => (
  <div
    role="status"
    className="flex items-center gap-2 font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-muted"
  >
    {/* A shutter closing: the key light travels round the ring rather than a full circle
        spinning, which is the same warm/cool pairing as the rest of the console. */}
    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-hairline border-t-key" />
    {label}
  </div>
);

export default Spinner;
