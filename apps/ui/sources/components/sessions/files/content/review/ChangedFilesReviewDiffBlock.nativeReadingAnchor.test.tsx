import React from 'react';
import type { View } from 'react-native';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { installCodeViewCommonModuleMocks } from '@/components/ui/code/view/codeViewTestHelpers';
import { createChangedFilesReviewDiffStateSource } from './ChangedFilesReviewDiffStore';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({ useLocalSetting: () => 1 });
});
installCodeViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'android' });
    },
});

describe('native review block reading continuity', () => {
    it.each([false, true])('retains the visible passage when the diff store refreshes, comments=%s', async (reviewCommentsEnabled) => {
        const { ChangedFilesReviewDiffBlock } = await import('./ChangedFilesReviewDiffBlock');
        const source = createChangedFilesReviewDiffStateSource();
        const before = '@@ -1,4 +1,4 @@\n a\n b\n reading\n-d\n+changed';
        const after = '@@ -1,4 +1,5 @@\n+inserted\n a\n b\n reading\n-d\n+changed';
        source.setDiffState('a.txt', { status: 'loaded', diff: before, error: null });
        let scrollY = 80;
        const externalScrollView = {
            scrollRef: { current: { scrollTo: ({ y }: { y: number }) => { scrollY = y; } } },
            // Genuine native viewport geometry; internal store/viewer/mapping stay real.
            viewportRef: { current: { measureInWindow: (success: (x: number, y: number) => void) => success(0, 0) } as View },
            offsetRef: { current: scrollY },
        };
        const props = { theme: { colors: { text: { secondary: '#999' }, border: { default: '#999' } } }, sessionId: 's', snapshotSignature: null,
            filePath: 'a.txt', diffStateSource: source, reviewCommentsEnabled, reviewCommentDrafts: [], externalScrollView };
        const screen = await renderScreen(<ChangedFilesReviewDiffBlock {...props} />, {
            createNodeMock: (element) => {
                const id = (element.props as Record<string, unknown>).nativeID;
                if (typeof id === 'string') return {
                    measureInWindow: (success: (x: number, y: number, width: number, height: number) => void) => {
                        const index = Number(id.split(':').at(-1));
                        success(0, index * 25 - scrollY, 100, 25);
                    },
                };
                return { measureInWindow: (success: (x: number, y: number, width: number, height: number) => void) => success(0, -scrollY, 100, 500) };
            },
        });
        await act(async () => {
            for (const row of screen.tree.root.findAll((node) => String(node.type) === 'View')) row.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 100, height: 500 } } });
        });
        await act(async () => source.setDiffState('a.txt', { status: 'loaded', diff: after, error: null }));
        expect(scrollY).toBe(105);
    });
});
