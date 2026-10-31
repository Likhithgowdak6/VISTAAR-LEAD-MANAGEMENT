/**
 * Handing a number to the phone's own dialler.
 *
 * THE TWO THINGS WORTH PINNING HERE.
 *
 * FIRST, that a bad number is REFUSED rather than passed on. A contact with nothing on file, or
 * with a note where the number should be, must not produce a dialler full of rubbish or a
 * button that silently does nothing - and the refusal must not carry the value, because an
 * error message is the single most likely thing to end up in a log or a screenshot.
 *
 * SECOND, the `+`. An unencoded plus is read as a space in a URI, which silently drops the
 * country code off an international number and dials a domestic one instead. Every number in
 * this CRM is E.164.
 */
import { describe, expect, it, vi } from 'vitest';

import { isDiallable, NotDiallableError, openDialler } from '../lib/native-dialer';

const webDeps = () => {
  const navigate = vi.fn();
  return { navigate, deps: { isNative: () => false, navigate } };
};

const nativeDeps = () => {
  const openDiallerSpy = vi.fn().mockResolvedValue(undefined);
  return {
    openDiallerSpy,
    deps: { isNative: () => true, plugin: { openDialler: openDiallerSpy } },
  };
};

describe('what counts as a number', () => {
  it.each([
    ['international', '+919876543210'],
    ['domestic', '9876543210'],
    ['spaced', '+91 98765 43210'],
    ['punctuated', '+91 (98765) 432-10'],
  ])('accepts %s', (_label: string, value: string) => {
    expect(isDiallable(value)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['a name', 'MD Afjal'],
    ['a note', 'call via reception'],
    ['too short', '12'],
    ['an injection attempt', 'tel:+91;rm -rf /'],
  ])('REFUSES %s', (_label: string, value: string) => {
    expect(isDiallable(value)).toBe(false);
  });

  it('refuses null and undefined rather than throwing', () => {
    expect(isDiallable(null)).toBe(false);
    expect(isDiallable(undefined)).toBe(false);
  });
});

describe('on the web', () => {
  it('hands the number to the OS as a tel: link', async () => {
    const { navigate, deps } = webDeps();

    await openDialler('+919876543210', deps);

    expect(navigate).toHaveBeenCalledWith('tel:%2B919876543210');
  });

  it('ENCODES THE PLUS, so the country code survives', async () => {
    // Unencoded, `+` is a space in a URI and `+91…` becomes ` 91…` - a different number.
    const { navigate, deps } = webDeps();

    await openDialler('+919876543210', deps);

    expect(String(navigate.mock.calls[0]![0])).not.toContain('tel:+');
  });

  it('refuses a number that is not one, WITHOUT echoing it', async () => {
    const { navigate, deps } = webDeps();

    await expect(openDialler('call via reception', deps)).rejects.toBeInstanceOf(
      NotDiallableError,
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it('carries no customer data in the error', async () => {
    const { deps } = webDeps();

    await openDialler('MD Afjal 98765', deps).catch((error: Error) => {
      expect(error.message).toBe('NOT_DIALLABLE');
      expect(error.message).not.toContain('98765');
    });

    expect.assertions(2);
  });
});

describe('on Android', () => {
  it('goes through the plugin, which uses ACTION_DIAL', async () => {
    const { openDiallerSpy, deps } = nativeDeps();

    await openDialler('+919876543210', deps);

    expect(openDiallerSpy).toHaveBeenCalledWith({ number: '+919876543210' });
  });

  it('trims before handing over', async () => {
    const { openDiallerSpy, deps } = nativeDeps();

    await openDialler('  +919876543210  ', deps);

    expect(openDiallerSpy).toHaveBeenCalledWith({ number: '+919876543210' });
  });

  it('never reaches the plugin with a bad number', async () => {
    const { openDiallerSpy, deps } = nativeDeps();

    await expect(openDialler('', deps)).rejects.toBeInstanceOf(NotDiallableError);
    expect(openDiallerSpy).not.toHaveBeenCalled();
  });
});
