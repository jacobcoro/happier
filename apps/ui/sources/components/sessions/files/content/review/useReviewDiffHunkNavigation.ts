import * as React from 'react';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';

/** Hunk destinations use content rows because both diff engines can scroll to them. */
export function useReviewDiffHunkNavigation(diff: string) {
    const targets = React.useMemo(() => {
        const lines = buildCodeLinesFromUnifiedDiff({ unifiedDiff: diff });
        const result: string[] = [];
        let awaitingContent = false;
        for (const line of lines) {
            if (line.kind === 'header') {
                awaitingContent = true;
            } else if (awaitingContent && (line.oldLine !== null || line.newLine !== null)) {
                result.push(line.id);
                awaitingContent = false;
            }
        }
        return result;
    }, [diff]);
    const [selection, setSelection] = React.useState({ diff, index: -1 });
    const index = selection.diff === diff ? selection.index : -1;
    const move = (direction: -1 | 1) => {
        const nextIndex = Math.max(0, Math.min(targets.length - 1, index + direction));
        setSelection({ diff, index: nextIndex });
        return targets[nextIndex];
    };
    return {
        count: targets.length,
        scrollToLineId: targets[index],
        canPrevious: index > 0,
        canNext: index < targets.length - 1,
        next: () => move(1),
        previous: () => move(-1),
    };
}
