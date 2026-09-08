import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { useChangedFilesReviewFocusPath } from './useChangedFilesReviewFocusPath';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { renderHook } from '@/dev/testkit/hooks/renderHook';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function Harness(props: Readonly<{
    focusPath: string | null;
    reviewFiles: readonly ScmFileStatus[];
    expandPath: (path: string) => void;
    scrollToPath: (path: string) => void;
}>) {
    useChangedFilesReviewFocusPath({
        focusPath: props.focusPath,
        reviewFiles: props.reviewFiles,
        expandPath: props.expandPath,
        scrollToPath: props.scrollToPath,
    });
    return React.createElement('Harness');
}

describe('useChangedFilesReviewFocusPath', () => {
    it('can explicitly revisit the same file after scrolling elsewhere', async () => {
        vi.useFakeTimers();
        const scrollToPath = vi.fn();
        const hook = await renderHook(() => useChangedFilesReviewFocusPath({
            focusPath: null,
            reviewFiles: [{ fullPath: 'a.ts' } as ScmFileStatus],
            expandPath: () => {},
            scrollToPath,
        }));
        const focus = () => {
            const value: unknown = hook.getCurrent();
            if (value && typeof value === 'object' && 'focus' in value && typeof value.focus === 'function') value.focus('a.ts');
        };
        await act(async () => { focus(); vi.advanceTimersByTime(60); });
        await act(async () => { focus(); vi.advanceTimersByTime(60); });
        expect(scrollToPath.mock.calls).toEqual([['a.ts'], ['a.ts']]);
        vi.useRealTimers();
    });

    it('applies focus scrolling only once per focusPath value even if the file list identity changes', async () => {
        vi.useFakeTimers();
        const expandPath = vi.fn();
        const scrollToPath = vi.fn();

        const file = { fullPath: 'src/a.ts' } as any as ScmFileStatus;

        const screen = await renderScreen(<Harness focusPath="src/a.ts" reviewFiles={[file]} expandPath={expandPath} scrollToPath={scrollToPath} />);
        const tree: Awaited<ReturnType<typeof renderScreen>>['tree'] = screen.tree;

        await flushHookEffects({ cycles: 1, turns: 1, advanceTimersMs: 60 });

        expect(expandPath).toHaveBeenCalledTimes(1);
        expect(scrollToPath).toHaveBeenCalledTimes(1);

        await act(async () => {
            tree.update(
                <Harness
                    focusPath="src/a.ts"
                    reviewFiles={[{ ...file }]}
                    expandPath={expandPath}
                    scrollToPath={scrollToPath}
                />
            );
        });

        await flushHookEffects({ cycles: 1, turns: 1, advanceTimersMs: 60 });

        expect(expandPath).toHaveBeenCalledTimes(1);
        expect(scrollToPath).toHaveBeenCalledTimes(1);

        vi.useRealTimers();
    });
});
