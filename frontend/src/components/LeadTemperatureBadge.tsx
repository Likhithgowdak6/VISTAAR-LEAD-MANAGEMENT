import { getLeadTemperatureStyle } from '../lib/lead-temperature';

type Props = {
  temperature?: string | null;
};

/**
 * Whether this lead is waiting on an answer, in one pill.
 *
 * SHOWS "NEW" RATHER THAN NOTHING, unlike LeadScoreBadge next to it. The score badge hides
 * itself for an unscored lead because an inbox where every row says "LOW INTENT" tells the owner
 * nothing. Temperature is the opposite: "New" is the single most useful thing to know about a
 * row - somebody arrived and has not been spoken to - and it is exactly the state that used to
 * render as "Cold" and get written off.
 */
const LeadTemperatureBadge = ({ temperature }: Props) => {
  const style = getLeadTemperatureStyle(temperature);

  return (
    <span className={style.className} title={style.handling}>
      {style.label}
    </span>
  );
};

export default LeadTemperatureBadge;
