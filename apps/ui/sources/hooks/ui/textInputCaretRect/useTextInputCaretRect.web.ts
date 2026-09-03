import * as React from 'react';
import getCaretCoordinates from 'textarea-caret';

import type {
    CaretRect,
    UseTextInputCaretRectInput,
} from './useTextInputCaretRect.types';

export type { CaretRect, TextInputCaretRectHandle, UseTextInputCaretRectInput } from './useTextInputCaretRect.types';

/**
 * Pure, unit-testable math: transforms textarea-local caret coordinates
 * into viewport-relative coordinates using the element's bounding rect
 * and scroll offsets.
 *
 * Per D47: uses viewport/client coordinates (no window.scrollX/Y addition).
 * Per D39: this is the jsdom-safe test target; real textarea-caret is Playwright-validated.
 */
export function computeWebCaretRect(
    elRect: Readonly<{ left: number; top: number }>,
    elScroll: Readonly<{ left: number; top: number }>,
    caret: Readonly<{ left: number; top: number; height: number }>,
): CaretRect {
    return {
        left: elRect.left + caret.left - elScroll.left,
        top: elRect.top + caret.top - elScroll.top,
        height: caret.height,
    };
}

/**
 * Cross-platform caret-rect hook (web implementation).
 *
 * Uses `textarea-caret` to measure caret position in a `<textarea>` element,
 * then transforms to viewport-relative coordinates.
 *
 * Returns `null` while disabled, before first measurement, or when the textarea
 * ref is unavailable.
 *
 * Measurement is gated on `measure` rather than on focus. `textarea-caret` clones the textarea into
 * a mirror element and reads its computed style, and the follow-up `getBoundingClientRect` forces
 * layout; running that on every keystroke costs a forced layout and an extra render per character
 * while the rect is only read when the autocomplete menu is open.
 */
export function useTextInputCaretRect(input: UseTextInputCaretRectInput): CaretRect | null {
    const { inputRef, selection, enabled = true, measure: measureEnabled = true } = input;

    const [rect, setRect] = React.useState<CaretRect | null>(null);

    const shouldMeasure = enabled && measureEnabled;

    // A LAYOUT effect, not a passive one, and that is load-bearing. `measure` flips to true in the
    // same commit that opens the menu, so a passive effect would let the menu paint once against
    // the fallback anchor and jump on the next frame -- the exact report D38 describes. A layout
    // effect's `setRect` re-renders before the browser paints, so the menu's first paint is anchored.
    React.useLayoutEffect(() => {
        if (!shouldMeasure) {
            // Only a disabled hook clears the rect. When the hook is enabled but idle the last
            // measurement is kept deliberately: `measure` goes false on every keystroke outside an
            // autocomplete word, and clearing here would throw away the anchor between menu opens.
            if (!enabled) setRect(null);

            return;
        }

        const el = inputRef.current?.getInputElement();
        if (el == null) {
            setRect(null);
            return;
        }

        const selectionStart = selection?.start ?? 0;

        const measure = () => {
            const caretCoords = getCaretCoordinates(el, selectionStart);
            const elRect = el.getBoundingClientRect();

            setRect(computeWebCaretRect(
                { left: elRect.left, top: elRect.top },
                { left: el.scrollLeft, top: el.scrollTop },
                caretCoords,
            ));
        };

        measure();

        // Subscribe to scroll for live tracking (D18).
        el.addEventListener('scroll', measure);

        return () => {
            el.removeEventListener('scroll', measure);
        };
    }, [inputRef, selection?.start, selection?.end, enabled, shouldMeasure]);

    if (!enabled) return null;

    return rect;
}
