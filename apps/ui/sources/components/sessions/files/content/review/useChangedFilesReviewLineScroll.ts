import * as React from 'react';
import type { View } from 'react-native';
import type { DiffFilesListViewHandle } from '@/components/ui/code/diff/DiffFilesListView';

/** Inline native diffs use the review list's scroll owner rather than a nested viewport. */
export function useChangedFilesReviewLineScroll(input: Readonly<{
    viewportRef: React.RefObject<View | null>;
    listRef: React.RefObject<DiffFilesListViewHandle | null>;
    scrollTopRef: React.RefObject<number>;
}>): (windowY: number) => void {
    const { viewportRef, listRef, scrollTopRef } = input;
    return React.useCallback((windowY: number) => {
        viewportRef.current?.measureInWindow((_x, viewportY) => {
            listRef.current?.scrollToOffset({
                offset: Math.max(0, scrollTopRef.current + windowY - viewportY),
                animated: false,
            });
        });
    }, [listRef, scrollTopRef, viewportRef]);
}
