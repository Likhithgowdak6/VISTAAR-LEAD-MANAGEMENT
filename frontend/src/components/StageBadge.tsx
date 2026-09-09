import { type CSSProperties } from 'react';

import { getBuiltinStageStyle } from '../lib/stages';

// `label` and `color` are for a custom (non-built-in) stage, resolved by the caller from the
// merged stage list — StageBadge itself never fetches the catalog.
type Props = {
  stage?: string | null;
  label?: string | null;
  color?: string | null;
};

const StageBadge = ({ stage, label, color }: Props) => {
  if (!stage) {
    return null;
  }

  const builtinClassName = getBuiltinStageStyle(stage) as string | null;
  const displayLabel = label ?? stage;

  if (builtinClassName) {
    return <span className={builtinClassName}>{displayLabel}</span>;
  }

  // A custom stage: tint the chip with the stage's own color. The colour is the org's choice, so
  // it is used at 15% for the fill and full strength for the text and border - readable on the
  // graded base whatever hue they picked, without a light pill punching a hole in the panel.
  const tintStyle: CSSProperties | undefined = color
    ? { backgroundColor: `${color}26`, borderColor: `${color}59`, color }
    : undefined;

  return (
    <span className="chip" style={tintStyle}>
      {displayLabel}
    </span>
  );
};

export default StageBadge;
