type Props = {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Describes what is being switched, for screen readers and for the tooltip. */
  label: string;
  disabled?: boolean;
  /** `sm` is for list rows, where the toggle sits beside a name and must not shout. */
  size?: 'sm' | 'md';
};

/**
 * A switch, not a checkbox.
 *
 * Used where the thing being controlled is a running behaviour rather than a saved preference:
 * turning the AI off for a lead stops it doing anything in that chat from that moment, and the
 * control should look like something that is currently on or off, not like a form field waiting
 * to be submitted.
 *
 * Deliberately a real `<button role="switch">` rather than a styled checkbox: it carries
 * `aria-checked`, it is reachable and operable from the keyboard for free, and the state is never
 * conveyed by colour alone - the knob's position says it too, which matters for the roughly one
 * in twelve men who cannot reliably separate the red from the green.
 */
const ToggleSwitch = ({ checked, onChange, label, disabled = false, size = 'md' }: Props) => {
  const track = size === 'sm' ? 'h-4 w-7' : 'h-5 w-9';
  const knob = size === 'sm' ? 'h-3 w-3' : 'h-4 w-4';
  const travel = size === 'sm' ? 'translate-x-3' : 'translate-x-4';

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(event) => {
        // Rows are themselves buttons that open a thread; flipping the switch must not also
        // navigate.
        event.stopPropagation();
        onChange(!checked);
      }}
      className={`relative inline-flex shrink-0 items-center rounded-full border transition-colors disabled:opacity-40 ${track} ${
        checked
          ? 'border-fill/50 bg-fill/30 shadow-[0_0_8px_-2px_rgb(79_209_197/60%)]'
          : 'border-hairline bg-panel-2'
      }`}
    >
      <span
        aria-hidden="true"
        className={`inline-block transform rounded-full bg-bone transition-transform ${knob} ${
          checked ? travel : 'translate-x-0.5'
        }`}
      />
    </button>
  );
};

export default ToggleSwitch;
