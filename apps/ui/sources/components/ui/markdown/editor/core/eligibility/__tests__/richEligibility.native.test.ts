import { describe, expect, it } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';

import { useRichEligibility } from '../richEligibility.native';
import { useRichEligibility as resolveFromBase } from '../richEligibility';

const OPTS = { language: 'markdown', maxBytes: 256_000, htmlRoundTripMaxBytes: 50_000 } as const;

describe('useRichEligibility (native)', () => {
    it('admits clean markdown', async () => {
        const state = await renderHook(() => useRichEligibility('# Clean native doc', OPTS));
        expect(state.getCurrent()).toEqual({ eligible: true });
    });

    it('blocks HTML-containing markdown (no round-trip adapter on native)', async () => {
        const state = await renderHook(() => useRichEligibility('# Doc\n\n<div>x</div> native', OPTS));
        expect(state.getCurrent()).toEqual({
            eligible: false,
            reason: 'html-or-jsx',
        });
    });

    it('blocks .mdx via the language gate', async () => {
        const state = await renderHook(() => useRichEligibility('# Doc native mdx', { ...OPTS, language: 'mdx' }));
        expect(state.getCurrent()).toEqual({
            eligible: false,
            reason: 'mdx',
        });
    });

    it('is re-exported unchanged from the base richEligibility module', () => {
        expect(resolveFromBase).toBe(useRichEligibility);
    });
});
