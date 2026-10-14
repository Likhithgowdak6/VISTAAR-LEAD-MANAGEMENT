/**
 * The inbox pill that says how warm a lead is.
 *
 * WHAT WENT WRONG. The row rendered the SCORE band here. Its 20-49 tier is called "cold", so a
 * screen full of imported leads that nobody had ever contacted came up labelled Cold - they had
 * a date and a city from the form, scored 35, and looked like dead ends on the day they
 * arrived. The same component rendered NOTHING for a lead who had messaged a minute ago but had
 * not yet given any details, because a zero score is hidden on purpose.
 *
 * So the two behaviours worth pinning are opposites of each other: temperature must SHOW "New"
 * where the score badge hid itself, and must not say "Cold" about anyone who has never written.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import LeadScoreBadge from '../components/LeadScoreBadge';
import LeadTemperatureBadge from '../components/LeadTemperatureBadge';
import { getLeadTemperatureStyle } from '../lib/lead-temperature';

describe('LeadTemperatureBadge', () => {
  it.each([
    ['new', 'New'],
    ['hot', 'Hot'],
    ['cold', 'Cold'],
  ])('renders %j as %j', (temperature, label) => {
    render(<LeadTemperatureBadge temperature={temperature} />);

    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('shows New rather than hiding, unlike the score badge', () => {
    render(<LeadTemperatureBadge temperature="new" />);

    // "Somebody arrived and has not been spoken to" is the most useful thing a row can say.
    // It is also precisely the state that used to render as "Cold".
    expect(screen.getByText('New')).toBeInTheDocument();
  });

  it('explains itself on hover', () => {
    render(<LeadTemperatureBadge temperature="cold" />);

    expect(screen.getByText('Cold')).toHaveAttribute(
      'title',
      'They have written before, but not in over 24 hours',
    );
  });

  it.each([null, undefined, '', 'something_new'])(
    'falls back to New, never Cold, for %j',
    (value) => {
      render(<LeadTemperatureBadge temperature={value as never} />);

      // An older backend that does not send the field yet. Showing "Cold" for "we do not know"
      // would tell the owner to stop chasing a lead who may have written an hour ago.
      expect(screen.getByText('New')).toBeInTheDocument();
    },
  );
});

describe('getLeadTemperatureStyle', () => {
  it('never returns undefined for an unknown value', () => {
    expect(getLeadTemperatureStyle('martian')).toEqual(getLeadTemperatureStyle('new'));
  });
});

describe('the score badge is still a SCORE badge', () => {
  it('keeps hiding itself for an unscored lead', () => {
    const { container } = render(<LeadScoreBadge band="low_intent" score={0} />);

    // Unchanged on purpose. An inbox where every row shouts "LOW INTENT" tells nobody anything,
    // and that reasoning still holds - it is only the temperature slot that was wrong.
    expect(container).toBeEmptyDOMElement();
  });

  it('still renders a genuinely high-intent lead', () => {
    render(<LeadScoreBadge band="hot" score={85} />);

    expect(screen.getByText('Hot')).toBeInTheDocument();
  });
});
