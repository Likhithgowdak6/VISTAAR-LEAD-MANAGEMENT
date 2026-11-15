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

  // Keep custom colors as an accent, so even pale stage colors have readable labels.
  const tintStyle: CSSProperties | undefined = color
    ? ({ '--stage-accent': color } as CSSProperties)
    : undefined;

  return (
    <span className={`chip${color ? ' chip-custom' : ''}`} style={tintStyle}>
      {displayLabel}
    </span>
  );
};

export default StageBadge;
