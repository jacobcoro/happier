import * as React from 'react';

import type { ScmFileStatus } from '@/scm/scmStatusFiles';

export function useChangedFilesReviewFocusPath(input: Readonly<{
    focusPath: string | null;
    reviewFiles: readonly ScmFileStatus[];
    expandPath: (path: string) => void;
    scrollToPath: (path: string) => void;
}>): Readonly<{ highlightedPath: string | null; focus: (path: string) => void }> {
    const [highlightedPath, setHighlightedPath] = React.useState<string | null>(null);
    const appliedFocusPathRef = React.useRef<string | null>(null);
    const latestInputRef = React.useRef(input);
    latestInputRef.current = input;
    const scrollTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const clearTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const clearTimers = React.useCallback(() => {
        if (scrollTimerRef.current !== null) clearTimeout(scrollTimerRef.current);
        if (clearTimerRef.current !== null) clearTimeout(clearTimerRef.current);
    }, []);
    const focus = React.useCallback((path: string) => {
        if (!latestInputRef.current.reviewFiles.some((file) => file.fullPath === path)) return;
        clearTimers();
        setHighlightedPath(path);
        latestInputRef.current.expandPath(path);
        scrollTimerRef.current = setTimeout(() => latestInputRef.current.scrollToPath(path), 50);
        clearTimerRef.current = setTimeout(() => setHighlightedPath(null), 8000);
    }, [clearTimers]);

    React.useEffect(() => {
        const path = input.focusPath;
        if (!path) {
            appliedFocusPathRef.current = null;
            return;
        }
        if (appliedFocusPathRef.current === path) return;
        if (!input.reviewFiles.some((file) => file.fullPath === path)) return;
        appliedFocusPathRef.current = path;
        focus(path);
    }, [focus, input.focusPath, input.reviewFiles]);
    React.useEffect(() => clearTimers, [clearTimers]);

    return { highlightedPath, focus };
}
