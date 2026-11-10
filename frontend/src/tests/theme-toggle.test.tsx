import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { ThemeProvider, useTheme } from '../context/ThemeContext';
import ThemeToggle from '../components/ThemeToggle';

const TestConsumer = () => {
  const { theme } = useTheme();
  return <div data-testid="current-theme">{theme}</div>;
};

describe('Dark Mode & ThemeToggle', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    document.documentElement.removeAttribute('data-theme');
  });

  it('defaults to light mode and toggles to dark mode on click', () => {
    render(
      <ThemeProvider>
        <ThemeToggle />
        <TestConsumer />
      </ThemeProvider>,
    );

    const toggle = screen.getByRole('button', { name: /switch to dark mode/i });
    expect(toggle).toBeInTheDocument();
    expect(screen.getByTestId('current-theme')).toHaveTextContent('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    // Click to toggle to dark
    fireEvent.click(toggle);

    expect(screen.getByTestId('current-theme')).toHaveTextContent('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('vistaar-theme')).toBe('dark');

    // Click again to toggle back to light
    fireEvent.click(screen.getByRole('button', { name: /switch to light mode/i }));

    expect(screen.getByTestId('current-theme')).toHaveTextContent('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem('vistaar-theme')).toBe('light');
  });

  it('restores stored dark mode preference from localStorage', () => {
    localStorage.setItem('vistaar-theme', 'dark');

    render(
      <ThemeProvider>
        <ThemeToggle />
        <TestConsumer />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('current-theme')).toHaveTextContent('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});

