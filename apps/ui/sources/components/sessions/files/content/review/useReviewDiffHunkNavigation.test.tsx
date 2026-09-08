import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { useReviewDiffHunkNavigation } from './useReviewDiffHunkNavigation';

describe('review hunk navigation', () => {
    it('visits content in each hunk, bounds navigation, and resets when the diff changes', async () => {
        let diff = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n@@ -30 +30 @@\n-before\n+after';
        const hook = await renderHook(() => useReviewDiffHunkNavigation(diff));
        expect(hook.getCurrent().scrollToLineId).toBeUndefined();
        expect(hook.getCurrent().count).toBe(2);
        await act(async () => { hook.getCurrent().next(); });
        expect(hook.getCurrent().scrollToLineId).toBe('r:4');
        expect(hook.getCurrent().canPrevious).toBe(false);
        await act(async () => { hook.getCurrent().next(); });
        expect(hook.getCurrent().scrollToLineId).toBe('r:7');
        expect(hook.getCurrent().canNext).toBe(false);
        await act(async () => { hook.getCurrent().next(); });
        expect(hook.getCurrent().scrollToLineId).toBe('r:7');
        await act(async () => { hook.getCurrent().previous(); });
        expect(hook.getCurrent().scrollToLineId).toBe('r:4');
        diff = '@@ -0,0 +1 @@\n+added';
        await hook.rerender();
        expect(hook.getCurrent().scrollToLineId).toBeUndefined();
        await act(async () => { hook.getCurrent().next(); });
        expect(hook.getCurrent().scrollToLineId).toBe('a:1');
        diff = '';
        await hook.rerender();
        expect(hook.getCurrent().count).toBe(0);
        expect(hook.getCurrent().canNext).toBe(false);
    });
});
