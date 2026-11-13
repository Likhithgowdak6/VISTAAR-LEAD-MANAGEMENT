import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { hapticSelection } from '../../lib/haptics';
import { pushBackLayer, removeBackLayer, type BackLayer } from '../../lib/mobile-back-stack';

/**
 * iOS-style option picker for every `<select>` in the app, on phone-sized screens.
 *
 * WHY A HOST INSTEAD OF A <Select> COMPONENT. The app has ~30 native selects across 19 files,
 * each controlled by React with its own onChange, and the tests drive them as real comboboxes.
 * Replacing them all would touch every form and every test for a purely visual change. Instead
 * this listens at the document for a tap on a select, keeps the browser's own picker from opening
 * (on Android that is a dated Material dialog that ignores the app's theme), and shows this sheet.
 * Choosing a row writes the value back INTO THE REAL SELECT and fires the same `change` event a
 * native pick would, so every component's onChange runs exactly as before.
 *
 * Desktop widths, keyboard use and jsdom are untouched: the sheet only takes over a pointer or
 * touch tap while the mobile layout is showing, so the native control remains the source of
 * truth everywhere else.
 */

const MOBILE_QUERY = '(max-width: 1023.98px)';
/** A touch that travels further than this was a scroll, not a tap. */
const TAP_SLOP_PX = 10;

interface SheetOption {
  value: string;
  label: string;
  disabled: boolean;
  group: string | null;
}

interface SheetState {
  select: HTMLSelectElement;
  title: string;
  options: SheetOption[];
  value: string;
}

const isEligible = (target: EventTarget | null): HTMLSelectElement | null => {
  if (!(target instanceof HTMLSelectElement)) return null;
  if (target.disabled || target.multiple || target.size > 1) return null;
  if (typeof window.matchMedia !== 'function' || !window.matchMedia(MOBILE_QUERY).matches) {
    return null;
  }
  return target;
};

const titleFor = (select: HTMLSelectElement): string => {
  const fromLabel = select.labels?.[0]?.textContent ?? '';
  const raw = fromLabel || select.getAttribute('aria-label') || select.title || 'Choose an option';
  return raw.replace(/\(optional\)/i, '').replace(/\s+/g, ' ').trim();
};

const readOptions = (select: HTMLSelectElement): SheetOption[] =>
  Array.from(select.options).map((option) => ({
    value: option.value,
    label: option.textContent?.trim() || option.value,
    disabled: option.disabled,
    group: option.parentElement instanceof HTMLOptGroupElement ? option.parentElement.label : null,
  }));

/** Sets a React-controlled select the way a real pick does, so its onChange fires. */
const commitValue = (select: HTMLSelectElement, value: string) => {
  if (select.value === value) return;
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
};

const Check = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true" className="h-5 w-5 shrink-0" fill="none">
    <path
      d="M4.5 10.5 8.25 14 15.5 6"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const SelectSheetHost = () => {
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const layerRef = useRef<BackLayer | null>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const selectedRef = useRef<HTMLButtonElement | null>(null);

  const open = useCallback((select: HTMLSelectElement) => {
    select.blur();
    void hapticSelection();
    setSheet({
      select,
      title: titleFor(select),
      options: readOptions(select),
      value: select.value,
    });
  }, []);

  const close = useCallback(() => {
    setSheet(null);
  }, []);

  // Take over taps on selects. Capture phase, so this runs before the browser opens its picker.
  useEffect(() => {
    const onTouchStart = (event: TouchEvent) => {
      if (!isEligible(event.target)) return;
      const touch = event.touches[0];
      touchStartRef.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
    };

    const onTouchEnd = (event: TouchEvent) => {
      const select = isEligible(event.target);
      if (!select) return;
      const start = touchStartRef.current;
      const touch = event.changedTouches[0];
      touchStartRef.current = null;
      if (start && touch) {
        const moved = Math.hypot(touch.clientX - start.x, touch.clientY - start.y);
        if (moved > TAP_SLOP_PX) return; // a scroll that happened to start on a select
      }
      // Cancelling touchend suppresses the synthesized mousedown/click, which is what would
      // otherwise open the native picker.
      event.preventDefault();
      open(select);
    };

    const onMouseDown = (event: MouseEvent) => {
      const select = isEligible(event.target);
      if (!select) return;
      event.preventDefault();
      open(select);
    };

    document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
    document.addEventListener('touchend', onTouchEnd, { capture: true, passive: false });
    document.addEventListener('mousedown', onMouseDown, { capture: true });
    return () => {
      document.removeEventListener('touchstart', onTouchStart, { capture: true });
      document.removeEventListener('touchend', onTouchEnd, { capture: true });
      document.removeEventListener('mousedown', onMouseDown, { capture: true });
    };
  }, [open]);

  // While open: Android back and Escape close it, and the chosen row starts in view.
  useEffect(() => {
    if (!sheet) return undefined;
    const layer = pushBackLayer(() => {
      layerRef.current = null;
      setSheet(null);
    });
    layerRef.current = layer;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSheet(null);
    };
    document.addEventListener('keydown', onKey);
    selectedRef.current?.scrollIntoView({ block: 'center' });
    return () => {
      document.removeEventListener('keydown', onKey);
      removeBackLayer(layerRef.current);
      layerRef.current = null;
    };
  }, [sheet]);

  if (!sheet) return null;

  const choose = (option: SheetOption) => {
    if (option.disabled) return;
    void hapticSelection();
    commitValue(sheet.select, option.value);
    close();
    sheet.select.focus({ preventScroll: true });
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-end bg-black/40 animate-fade-in"
      onClick={close}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={sheet.title}
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-[78dvh] w-full flex-col rounded-t-[2rem] bg-[#f2f2f7] pb-[calc(0.75rem+env(safe-area-inset-bottom))] shadow-[0_-12px_40px_-8px_rgba(0,0,0,0.25)] animate-slide-up dark:bg-[#1c1c1e]"
      >
        <div aria-hidden="true" className="mx-auto mt-2 h-[5px] w-9 rounded-full bg-black/20 dark:bg-white/25" />

        <div className="flex items-center gap-3 px-5 pb-3 pt-3">
          <p className="min-w-0 flex-1 truncate text-[1.0625rem] font-semibold text-[#1d1d1f] dark:text-white">
            {sheet.title}
          </p>
          <button
            type="button"
            onClick={close}
            className="h-9 shrink-0 rounded-full bg-[#7676801f] px-4 text-[0.9375rem] font-semibold text-[#007aff] dark:bg-[#76768033] dark:text-[#0a84ff]"
          >
            Cancel
          </button>
        </div>

        <div className="mx-3 min-h-0 overflow-y-auto overscroll-contain rounded-[1.25rem] bg-[#fff] dark:bg-[#2c2c2e]">
          <div role="listbox" aria-label={sheet.title}>
            {sheet.options.map((option, index) => {
              const selected = option.value === sheet.value;
              const startsGroup =
                option.group !== null &&
                (index === 0 || sheet.options[index - 1].group !== option.group);
              const header =
                startsGroup ? (
                  <p
                    key={`group-${option.group}`}
                    className="bg-[#f2f2f7] px-4 pb-1.5 pt-3 text-[0.8125rem] font-semibold text-[#6e6e73] dark:bg-[#1c1c1e] dark:text-[#8e8e93]"
                  >
                    {option.group}
                  </p>
                ) : null;
              return (
                <div key={`${option.value}-${index}`}>
                  {header}
                  <button
                    ref={selected ? selectedRef : undefined}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    disabled={option.disabled}
                    onClick={() => choose(option)}
                    className={`flex h-[3.25rem] w-full items-center gap-3 px-4 text-left text-[1rem] transition-colors active:bg-[#7676801f] disabled:opacity-35 dark:active:bg-[#76768033] ${
                      index > 0 && !header ? 'border-t border-black/[0.08] dark:border-white/10' : ''
                    } ${
                      selected
                        ? 'font-semibold text-[#007aff] dark:text-[#0a84ff]'
                        : 'text-[#1d1d1f] dark:text-white'
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {selected ? <Check /> : null}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default SelectSheetHost;
