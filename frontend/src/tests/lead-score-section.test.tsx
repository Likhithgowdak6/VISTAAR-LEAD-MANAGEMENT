import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import LeadScoreBadge from '../components/LeadScoreBadge';
import LeadScoreSection from '../components/lead/LeadScoreSection';

afterEach(() => {
  vi.clearAllMocks();
});

describe('LeadScoreSection', () => {
  it('shows the score, the band and what the band means for handling', () => {
    render(
      <LeadScoreSection
        leadScore={85}
        leadScoreBand="hot"
        leadScoreSignals={['event_date', 'venue', 'budget', 'quotation_requested', 'replied']}
      />,
    );

    expect(screen.getByText('Lead score')).toBeInTheDocument();
    expect(screen.getByText('/100')).toBeInTheDocument();
    expect(screen.getByText('Hot · 85')).toBeInTheDocument();
    expect(screen.getByText('Call this one yourself')).toBeInTheDocument();
  });

  it('renders every signal, ticking the ones that fired', () => {
    render(
      <LeadScoreSection leadScore={35} leadScoreBand="cold" leadScoreSignals={['event_date', 'replied']} />,
    );

    const fired = screen.getByText(/Event date given/);
    expect(fired.textContent).toContain('✓');
    expect(within(fired.closest('li') as HTMLElement).getByText('+20')).toBeInTheDocument();

    const missing = screen.getByText(/Venue given/);
    expect(missing.textContent).toContain('○');
    expect(
      within(missing.closest('li') as HTMLElement).getByText('+15 if asked'),
    ).toBeInTheDocument();
  });

  it('lists what is still missing, which is what the owner asks about next', () => {
    render(<LeadScoreSection leadScore={20} leadScoreBand="cold" leadScoreSignals={['event_date']} />);

    for (const label of [
      'Venue given',
      'Budget given',
      'Asked for a quotation',
      'Replied to the AI',
      'Asked about availability',
    ]) {
      expect(screen.getByText(new RegExp(label))).toBeInTheDocument();
    }
  });

  it('renders a lead nobody has scored yet as zero, not as a blank', () => {
    render(<LeadScoreSection />);

    expect(screen.getByText('0')).toBeInTheDocument();
    expect(screen.getByText('Long-term nurture')).toBeInTheDocument();
  });
});

describe('LeadScoreBadge', () => {
  it.each([
    ['hot', 'Hot'],
    ['warm', 'Warm'],
    ['cold', 'Cold'],
  ])('renders the %s band as "%s"', (band, label) => {
    render(<LeadScoreBadge band={band} score={60} />);

    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('renders nothing for an unscored lead', () => {
    const { container } = render(<LeadScoreBadge band="low_intent" score={0} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the band is missing entirely', () => {
    const { container } = render(<LeadScoreBadge />);

    expect(container).toBeEmptyDOMElement();
  });

  it('still shows a low-intent lead that has actually scored something', () => {
    render(<LeadScoreBadge band="low_intent" score={15} />);

    expect(screen.getByText('Low intent')).toBeInTheDocument();
  });
});
