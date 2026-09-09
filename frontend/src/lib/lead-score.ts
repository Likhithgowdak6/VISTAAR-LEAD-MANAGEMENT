import { type LeadScoreBand } from '../types';

/**
 * The dashboard's side of lead scoring: what each band is called, how it is coloured, and what
 * each signal is called in the owner's words.
 *
 * Mirrored from the backend's conversations/lead-score.ts, the same way BUILTIN_STAGES mirrors
 * the backend's stage keys — the API sends keys and numbers, this file is where they become
 * something a person reads. The keys and the point values are a contract; if one moves, both
 * files move.
 */

export interface LeadScoreBandStyle {
  /** What the owner reads. */
  label: string;
  /** What it means for how the lead is handled — the client's own wording. */
  handling: string;
  /** Tailwind tint, in the same shape StageBadge uses for a built-in stage. */
  className: string;
}

/*
 * The bands read as exposure: a hot lead is a properly lit frame, a low-intent one is
 * underexposed. That is not decoration - it is the same instrument the exposure meter in
 * LeadScoreSection draws, so the chip in the list and the meter in the panel agree.
 */
export const LEAD_SCORE_BAND_STYLES: Readonly<Record<LeadScoreBand, LeadScoreBandStyle>> = {
  hot: {
    label: 'Hot',
    handling: 'Call this one yourself',
    className: 'chip chip-key animate-pulse-key',
  },
  warm: {
    label: 'Warm',
    handling: 'The AI keeps qualifying',
    className: 'chip chip-key',
  },
  cold: {
    label: 'Cold',
    handling: 'Automated nurture',
    className: 'chip chip-fill',
  },
  low_intent: {
    label: 'Low intent',
    handling: 'Long-term nurture',
    className: 'chip',
  },
};

const UNKNOWN_BAND_STYLE: LeadScoreBandStyle = {
  label: 'Unscored',
  handling: 'Nothing known about this lead yet',
  className: 'chip',
};

/**
 * Where each band starts on the 0-100 scale, mirroring the backend's own thresholds. Drawn as
 * the labelled stops on the exposure meter, so the scale shows not just where this lead sits but
 * how far it is from the next band.
 */
export const LEAD_SCORE_BAND_STOPS: readonly { at: number; label: string }[] = [
  { at: 0, label: 'Low' },
  { at: 20, label: 'Cold' },
  { at: 50, label: 'Warm' },
  { at: 80, label: 'Hot' },
];

/** The style for a band key, or a neutral one for a band this build does not know. */
export const getLeadScoreBandStyle = (band: string | null | undefined): LeadScoreBandStyle =>
  band && band in LEAD_SCORE_BAND_STYLES
    ? LEAD_SCORE_BAND_STYLES[band as LeadScoreBand]
    : UNKNOWN_BAND_STYLE;

export interface LeadScoreSignal {
  key: string;
  label: string;
  points: number;
}

/**
 * The six signals, in the order the client listed them — the order the breakdown renders, fired
 * or not. The missing ones are the useful half: they are what the owner asks about next.
 */
export const LEAD_SCORE_SIGNALS: readonly LeadScoreSignal[] = [
  { key: 'event_date', label: 'Event date given', points: 20 },
  { key: 'venue', label: 'Venue given', points: 15 },
  { key: 'budget', label: 'Budget given', points: 15 },
  { key: 'quotation_requested', label: 'Asked for a quotation', points: 15 },
  { key: 'replied', label: 'Replied to the AI', points: 20 },
  { key: 'availability_asked', label: 'Asked about availability', points: 15 },
];

export const LEAD_SCORE_MAX = 100;
