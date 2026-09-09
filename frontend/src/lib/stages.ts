import { type BuiltinStageKey, type Stage, type StageStatus } from '../types';

export interface BuiltinStage {
  key: BuiltinStageKey;
  label: string;
}

export interface MergedStage {
  key: string;
  label: string;
  color: string | null;
  status: StageStatus | string;
}

// The 7 permanent built-in stages — never deletable, unaffected by the custom stage catalog.
export const BUILTIN_STAGES: readonly BuiltinStage[] = [
  { key: 'new', label: 'New' },
  { key: 'contacted', label: 'Contacted' },
  { key: 'qualified', label: 'Qualified' },
  { key: 'proposal', label: 'Proposal' },
  { key: 'won', label: 'Won' },
  { key: 'lost', label: 'Lost' },
  { key: 'closed', label: 'Closed' },
];

/*
 * The pipeline is a sequence, so the badges are lit like one: a new lead sits unlit, warms
 * through the middle stages as the studio puts work into it, and a won deal is the brightest
 * thing in the row. Lost and closed go cold again. The temperature is the progress bar - which
 * is why these are not seven arbitrary hues.
 */
const BUILTIN_STYLES: Readonly<Record<BuiltinStageKey, string>> = {
  new: 'chip',
  contacted: 'chip chip-fill',
  qualified: 'chip chip-fill',
  proposal: 'chip chip-key',
  won: 'chip chip-key glow-key-soft',
  lost: 'chip border-danger/30 bg-danger/10 text-danger',
  closed: 'chip opacity-60',
};

export const getBuiltinStageStyle = (key: string | null | undefined): string | null =>
  key && key in BUILTIN_STYLES ? BUILTIN_STYLES[key as BuiltinStageKey] : null;

export type CustomStageInput = Pick<Stage, 'key' | 'label' | 'color' | 'status'> & {
  key: string;
  label: string;
};

/**
 * Combines the permanent built-ins with an org's custom stages (from `listStages()`) into one
 * list, so the picker (StageControl) and the display (StageBadge) work off a single source.
 * Custom entries keep their `status` and `color` so callers can filter/style as needed.
 */
export const mergeStages = (customStages: readonly CustomStageInput[] = []): MergedStage[] => [
  ...BUILTIN_STAGES.map((stage) => ({ ...stage, status: 'active' as const, color: null })),
  ...customStages.map((stage) => ({
    key: stage.key,
    label: stage.label,
    color: stage.color,
    status: stage.status,
  })),
];

export const findStageByKey = (
  stages: readonly MergedStage[],
  key: string | null | undefined,
): MergedStage | null => stages.find((stage) => stage.key === key) ?? null;
