/**
 * Rendering the assistant's answer.
 *
 * ----------------------------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ----------------------------------------------------------------------------------------------
 * The first version rendered the answer as plain text — safe, but wrong-looking: the model
 * writes markdown whether or not it is asked to, so real answers came out reading
 * `**Ananya Reddy is hot (score 92)**`. The page tests did not catch it because they asserted
 * on text content, which matches whether or not the asterisks are stripped. It took opening a
 * browser.
 *
 * The fix parses a subset of markdown into React elements. That introduces the risk this file
 * is mostly about: **the answer is derived from WhatsApp messages written by strangers.** A
 * markdown renderer that emits HTML would turn a customer's message into a script tag. Every
 * fragment here becomes a React child, which React escapes, and `dangerouslySetInnerHTML`
 * appears nowhere in the feature.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import AssistantMessage from '../components/assistant/AssistantMessage';

const answer = (content: string) =>
  render(<AssistantMessage role="assistant" content={content} />);

describe('AssistantMessage', () => {
  describe('escaping', () => {
    it('DOES NOT RENDER HTML FROM THE ANSWER', () => {
      // The answer quotes customer messages. If one contained this, it must stay text.
      const { container } = answer('The customer wrote: <img src=x onerror=alert(1)> today.');

      expect(container.querySelector('img')).toBeNull();
      expect(container.innerHTML).not.toContain('<img');
      expect(screen.getByText(/onerror=alert\(1\)/)).toBeInTheDocument();
    });

    it('does not render a script tag from a quoted message', () => {
      const { container } = answer('She said **<script>fetch("/steal")</script>** yesterday.');

      expect(container.querySelector('script')).toBeNull();
    });

    it('bold markup around hostile text still does not create an element', () => {
      const { container } = answer('**<b onmouseover=alert(1)>hover me</b>**');

      expect(container.querySelector('b[onmouseover]')).toBeNull();
    });
  });

  describe('bold', () => {
    it('RENDERS BOLD RATHER THAN PRINTING THE ASTERISKS', () => {
      // The exact defect found in the browser.
      answer('**Ananya Reddy is hot (score 92)**');

      expect(screen.getByText('Ananya Reddy is hot (score 92)').tagName).toBe('STRONG');
      expect(screen.queryByText(/\*\*/)).not.toBeInTheDocument();
    });

    it('handles bold in the middle of a sentence', () => {
      answer('Her score is **92** which is hot.');

      expect(screen.getByText('92').tagName).toBe('STRONG');
      expect(screen.getByText(/which is hot/)).toBeInTheDocument();
    });

    it('handles several bold runs in one line', () => {
      const { container } = answer('**Event date:** 12 December and **Budget:** 80,000');

      expect(container.querySelectorAll('strong')).toHaveLength(2);
    });

    it('leaves a single asterisk alone', () => {
      // Multiplication and footnote markers are not emphasis.
      answer('The rate is 2 * 40000 per day.');

      expect(screen.getByText(/2 \* 40000/)).toBeInTheDocument();
    });

    it('leaves an unclosed bold marker as text', () => {
      answer('She said **this and never closed it');

      expect(screen.getByText(/\*\*this and never closed it/)).toBeInTheDocument();
    });
  });

  describe('lists', () => {
    it('renders a bullet list', () => {
      const { container } = answer('- Event date: 12 December\n- Venue: Bengaluru');

      expect(container.querySelectorAll('li')).toHaveLength(2);
    });

    it('renders bold inside a bullet', () => {
      // The model's usual shape: "- **Event date:** 12 December".
      answer('- **Event date:** 12 December\n- **Venue:** Bengaluru');

      expect(screen.getByText('Event date:').tagName).toBe('STRONG');
    });

    it('a single bullet is still a list', () => {
      const { container } = answer('- Only one thing');

      expect(container.querySelectorAll('li')).toHaveLength(1);
    });

    it('does not treat a paragraph starting with a dash as a list', () => {
      const { container } = answer('- first item\nbut this line is prose');

      expect(container.querySelectorAll('li')).toHaveLength(0);
    });
  });

  describe('tables', () => {
    it('RENDERS A MARKDOWN TABLE AS A TABLE', () => {
      const { container } = answer(
        '| Lead | Score |\n| --- | --- |\n| Ananya Reddy | 92 |\n| Rahul Mehta | 55 |',
      );

      const table = container.querySelector('table');

      expect(table).not.toBeNull();
      expect(within(table as HTMLElement).getByText('Ananya Reddy')).toBeInTheDocument();
      expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    });

    it('drops the divider row rather than rendering it as data', () => {
      const { container } = answer('| Lead | Score |\n| --- | --- |\n| Ananya | 92 |');

      expect(container.textContent).not.toContain('---');
    });

    it('renders the header cells as headers', () => {
      const { container } = answer('| Lead | Score |\n| --- | --- |\n| Ananya | 92 |');

      expect(container.querySelectorAll('th')).toHaveLength(2);
    });

    it('A STRAY PIPE IN PROSE IS NOT A TABLE', () => {
      // "| 92" appearing mid-sentence must not become a one-column table.
      const { container } = answer('Her score | 92 | is the highest you have.');

      expect(container.querySelector('table')).toBeNull();
    });
  });

  describe('structure', () => {
    it('separates paragraphs', () => {
      const { container } = answer('First paragraph.\n\nSecond paragraph.');

      expect(container.querySelectorAll('p')).toHaveLength(2);
    });

    it('renders the question differently from the answer', () => {
      // The asymmetry is the point: a transcript where both sides look alike is one where a
      // glance cannot tell what the business asked from what the assistant inferred.
      const { container: question } = render(
        <AssistantMessage role="user" content="why is she hot?" />,
      );
      const { container: reply } = render(
        <AssistantMessage role="assistant" content="Because of the date." />,
      );

      expect(question.querySelector('[data-testid="assistant-question"]')).not.toBeNull();
      expect(reply.querySelector('[data-testid="assistant-answer"]')).not.toBeNull();
    });

    it('does not parse markdown in the question', () => {
      // The owner typed it. Asterisks they typed are asterisks they meant.
      render(<AssistantMessage role="user" content="**literally what I typed**" />);

      expect(screen.getByText('**literally what I typed**')).toBeInTheDocument();
    });
  });
});
