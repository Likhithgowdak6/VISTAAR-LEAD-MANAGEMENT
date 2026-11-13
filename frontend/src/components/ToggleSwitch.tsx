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
  // iOS proportions: a capsule track a little under twice as wide as it is tall.
  const track = size === 'sm' ? 'h-[20px] w-[34px]' : 'h-[26px] w-[44px]';
  const knob = size === 'sm' ? 'h-4 w-4' : 'h-[22px] w-[22px]';
  const travel = size === 'sm' ? 'translate-x-[16px]' : 'translate-x-[20px]';

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
      className={`relative inline-flex shrink-0 items-center rounded-full transition-colors duration-200 disabled:opacity-40 ${track} ${
        checked ? 'bg-[#34c759] dark:bg-[#30d158]' : 'bg-[#78788029] dark:bg-[#78788052]'
      }`}
    >
      <span
        aria-hidden="true"
        className={`keep-white inline-block transform rounded-full bg-white shadow-[0_3px_8px_rgba(0,0,0,0.15),0_1px_1px_rgba(0,0,0,0.16)] transition-transform duration-300 ease-[cubic-bezier(0.3,1.3,0.5,1)] ${knob} ${
          checked ? travel : 'translate-x-[2px]'
        }`}
      />
    </button>
  );
};

export default ToggleSwitch;
