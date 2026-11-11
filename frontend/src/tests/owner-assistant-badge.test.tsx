/**
 * The "Internal" marker on the owner's own assistant thread.
 *
 * WHAT IT PREVENTS. The owner conversation uses the same row, the same bubbles and the same
 * composer as a customer thread — deliberately, so there is no second interface to drift. The
 * cost of that reuse is that a teammate scanning the Inbox sees a conversation called "Owner
 * Assistant" and reasonably reads it as a client with that name. The badge is the only thing
 * saying otherwise.
 *
 * The absence tests matter more than the presence one: `kind` is absent on every conversation
 * that exists today, so a badge that rendered on a falsy check would appear on all of them.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import OwnerAssistantBadge from '../components/OwnerAssistantBadge';

describe('OwnerAssistantBadge', () => {
  it('marks the owner assistant thread', () => {
    render(<OwnerAssistantBadge kind="owner_assistant" />);

    expect(screen.getByText('Internal')).toBeInTheDocument();
  });

  it('IS ABSENT ON A CUSTOMER THREAD', () => {
    // `kind` is null on every existing conversation. A badge here would appear on the whole
    // inbox and mean nothing.
    render(<OwnerAssistantBadge kind={null} />);

    expect(screen.queryByText('Internal')).not.toBeInTheDocument();
  });

  it('is absent when the field is missing entirely', () => {
    // Older cached payloads predate the field, so `undefined` is a real case, not a
    // theoretical one.
    render(<OwnerAssistantBadge />);

    expect(screen.queryByText('Internal')).not.toBeInTheDocument();
  });

  it('does not render for some other future kind', () => {
    // An explicit equality check, not a truthiness one - so a `kind` added later for an
    // unrelated purpose does not silently inherit the "Internal" label.
    render(<OwnerAssistantBadge kind="broadcast" />);

    expect(screen.queryByText('Internal')).not.toBeInTheDocument();
  });

  it('CARRIES ITS MEANING FOR A SCREEN READER', () => {
    // The icon is decorative and hidden; the label is not. "Internal" alone is ambiguous out
    // of visual context, so the accessible name spells it out.
    render(<OwnerAssistantBadge kind="owner_assistant" />);

    expect(
      screen.getByLabelText('Internal assistant conversation'),
    ).toBeInTheDocument();
  });

  it('uses an svg icon rather than an emoji', () => {
    const { container } = render(<OwnerAssistantBadge kind="owner_assistant" />);

    expect(container.querySelector('svg')).toBeInTheDocument();
    expect(container.textContent).toBe('Internal');
  });

  it('hides the icon from assistive technology', () => {
    const { container } = render(<OwnerAssistantBadge kind="owner_assistant" />);

    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('CARRIES A DARK MODE CLASS FOR EVERY COLOUR IT SETS', () => {
    // The inbox is used in both modes. An amber-on-amber badge with no dark variant is
    // invisible against a near-black row, which is the failure mode this catches.
    const { container } = render(<OwnerAssistantBadge kind="owner_assistant" />);
    const classes = container.firstElementChild?.className ?? '';

    for (const prefix of ['text-amber', 'bg-amber', 'border-amber']) {
      expect(classes).toContain(`${prefix}`);
      expect(classes).toContain(`dark:${prefix}`);
    }
  });
});
