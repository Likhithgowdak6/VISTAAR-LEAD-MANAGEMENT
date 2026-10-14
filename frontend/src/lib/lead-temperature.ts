/**
 * How recently the customer last wrote - the thing an owner actually means by "hot" and "cold".
 *
 * SEPARATE FROM THE SCORE BAND NEXT DOOR IN lib/lead-score.ts, and the separation is the point.
 * That one measures buying intent out of six signals and happens to call its 20-49 band "cold".
 * Rendered in the inbox it read as a temperature, so an imported lead carrying a date and a city
 * scored 35 and was labelled "Cold" on the day it arrived, having never been contacted by
 * anyone. This says only: have they written, and how long ago.
 *
 * The backend derives the value on every read from `lastInboundAt`, so nothing here can be
 * stale - a lead who replies is HOT on the next refresh.
 */
import { type LeadTemperature } from '../types/models';

export type { LeadTemperature };

export interface LeadTemperatureStyle {
  label: string;
  /** The tooltip - what the owner should do about it. */
  handling: string;
  className: string;
}

export const LEAD_TEMPERATURE_STYLES: Readonly<Record<LeadTemperature, LeadTemperatureStyle>> = {
  new: {
    label: 'New',
    handling: 'No reply from them yet - nobody has gone quiet',
    className: 'chip',
  },
  hot: {
    label: 'Hot',
    handling: 'They wrote in the last 24 hours',
    className: 'chip chip-key animate-pulse-key',
  },
  cold: {
    label: 'Cold',
    handling: 'They have written before, but not in over 24 hours',
    className: 'chip chip-fill',
  },
};

/**
 * The style for a temperature, tolerating anything.
 *
 * Falls back to NEW rather than COLD for an unrecognised value - an older backend that does not
 * send the field yet, or a value this build has never heard of. Showing "Cold" for "we do not
 * know" is the one wrong answer here: it tells the owner to stop chasing a lead who may have
 * written an hour ago.
 */
export const getLeadTemperatureStyle = (temperature?: string | null): LeadTemperatureStyle =>
  LEAD_TEMPERATURE_STYLES[(temperature ?? 'new') as LeadTemperature] ??
  LEAD_TEMPERATURE_STYLES.new;
