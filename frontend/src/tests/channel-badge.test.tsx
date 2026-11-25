/**
 * The channel badge, and the compatibility rule it depends on.
 *
 * IT RENDERS NOTHING FOR WHATSAPP, deliberately. Almost every thread in this CRM is WhatsApp, so
 * badging all of them would be noise that makes the Instagram ones harder to spot — the opposite
 * of the point. The absence of a badge means WhatsApp, which is also what every conversation
 * written before the field existed is.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import ChannelBadge from '../components/ChannelBadge';

describe('ChannelBadge', () => {
  it('marks an Instagram thread', () => {
    render(<ChannelBadge channel="instagram" />);

    expect(screen.getByText('Instagram')).toBeInTheDocument();
  });

  it('renders nothing for WhatsApp', () => {
    const { container } = render(<ChannelBadge channel="whatsapp" />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a thread with no channel at all', () => {
    // A row from a server that predates the field. Treating undefined as "unknown" and showing a
    // badge would put one on most of the database.
    const { container } = render(<ChannelBadge channel={undefined} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for an explicit null', () => {
    const { container } = render(<ChannelBadge channel={null} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('explains itself on hover, because the reply rules differ', () => {
    // Instagram has a hard 24-hour window with no template to reopen it.
    render(<ChannelBadge channel="instagram" />);

    expect(screen.getByTitle(/Instagram DM/i)).toBeInTheDocument();
  });
});
