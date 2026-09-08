import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { useChangedFilesReviewLineScroll } from './useChangedFilesReviewLineScroll';
import type { View } from 'react-native';
import type { DiffFilesListViewHandle } from '@/components/ui/code/diff/DiffFilesListView';

describe('review line scrolling', () => {
    it('aligns a measured native code line with the existing review viewport using its current offset', async () => {
        const scrollToOffset = vi.fn();
        // Native measure/scroll handles are the OS boundaries; review coordinate conversion stays real.
        const viewportRef = { current: { measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 80, 600, 800) } as unknown as View };
        const listRef = { current: { scrollToOffset } as unknown as DiffFilesListViewHandle };
        const scrollTopRef = { current: 200 };
        const hook = await renderHook(() => useChangedFilesReviewLineScroll({ viewportRef, listRef, scrollTopRef }));
        hook.getCurrent()(180);
        expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 300, animated: false });
        scrollTopRef.current = 450;
        hook.getCurrent()(30);
        expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 400, animated: false });
    });
});
