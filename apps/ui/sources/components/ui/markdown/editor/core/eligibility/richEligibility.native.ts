/**
 * Native rich-eligibility resolver.
 *
 * Injects NO `htmlRoundTrip` adapter — there is no DOM in the RN JS bundle and
 * we must not import any `@tiptap/*` into the native graph (R18). HTML-containing
 * markdown is therefore conservatively blocked on native (R16); the rich editor
 * is offered only for clean markdown.
 *
 * PURE — NO `@tiptap/*` import.
 */

import * as React from 'react';

import {
    evaluateMarkdownRichEligibility,
    type MarkdownRichEligibility,
} from './markdownRichEligibility';

export type ResolveRichEligibilityOptions = Readonly<{
    language: string | null;
    maxBytes: number;
    htmlRoundTripMaxBytes: number;
}>;

/**
 * Resolves rich-eligibility on native (no HTML round-trip adapter).
 */
export function useRichEligibility(
    raw: string,
    opts: ResolveRichEligibilityOptions,
): MarkdownRichEligibility {
    return React.useMemo(
        () => evaluateMarkdownRichEligibility(raw, {
            language: opts.language,
            maxBytes: opts.maxBytes,
            htmlRoundTripMaxBytes: opts.htmlRoundTripMaxBytes,
        }),
        [raw, opts.language, opts.maxBytes, opts.htmlRoundTripMaxBytes],
    );
}
