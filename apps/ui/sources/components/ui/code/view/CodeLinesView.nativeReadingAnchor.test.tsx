import React from 'react';
import type { View } from 'react-native';
import type { CodeLine } from '../model/codeLineTypes';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { installCodeViewCommonModuleMocks } from './codeViewTestHelpers';
import { buildCodeLinesFromFile } from '../model/buildCodeLinesFromFile';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@/sync/store/hooks', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({ useLocalSetting: () => 1 });
});
installCodeViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        const FlatList = React.forwardRef<unknown, { data: CodeLine[]; renderItem: (args: { item: CodeLine; index: number }) => React.ReactNode }>((props, ref) =>
            React.createElement('FlatList', { ...props, ref }, props.data.map((item, index) => <React.Fragment key={item.id}>{props.renderItem({ item, index })}</React.Fragment>)));
        return createReactNativeNativeMock({ platformOS: 'ios' }, { FlatList });
    },
});

describe('native code reading continuity', () => {
    it('lets only the native viewer covering the viewport top restore a shared scroll owner', async () => {
        const { CodeLinesViewCore } = await import('./CodeLinesViewCore');
        let scrollY = 55;
        let inserted = false;
        const prefixes = new Map<string, number>();
        const externalScrollView = {
            scrollRef: { current: { scrollTo: ({ y }: { y: number }) => { scrollY = y; } } },
            // Native host geometry boundary.
            contentRef: { current: {} as View },
            offsetRef: { current: scrollY },
        };
        const render = () => <>
            <CodeLinesViewCore virtualized={false} externalScrollView={externalScrollView} lines={buildCodeLinesFromFile({ text: inserted ? 'inserted\na\nb\nreading\nd' : 'a\nb\nreading\nd' })} />
            <CodeLinesViewCore virtualized={false} externalScrollView={externalScrollView} lines={buildCodeLinesFromFile({ text: inserted ? 'one\ntwo\nlower\nend' : 'lower\nend' })} />
        </>;
        let roots = 0;
        const screen = await renderScreen(render(), {
            createNodeMock: (element) => {
                const id = (element.props as Record<string, unknown>).nativeID;
                if (typeof id === 'string') {
                    const prefix = id.split('-f:')[0];
                    if (!prefixes.has(prefix)) prefixes.set(prefix, prefixes.size);
                    const group = prefixes.get(prefix)!;
                    return { measureLayout: (_relative: unknown, done: (x: number, y: number, w: number, h: number) => void) => done(0, (group ? 300 + (inserted ? 25 : 0) : 0) + (Number(id.split(':').at(-1)) - 1) * 25, 100, 25) };
                }
                const style = (element.props as Record<string, unknown>).style;
                if (style && typeof style === 'object' && 'paddingVertical' in style) {
                    const group = roots++;
                    return { measureLayout: (_relative: unknown, done: (x: number, y: number, w: number, h: number) => void) => done(0, group ? 300 : 0, 100, 200) };
                }
                return null;
            },
        });
        await act(async () => {
            for (const node of screen.tree.root.findAll((node) => String(node.type) === 'View')) node.props.onLayout?.();
        });
        inserted = true;
        await act(async () => screen.tree.update(render()));
        expect(scrollY).toBe(80);
    });

    it('uses measured row geometry when refreshed lines above the passage wrap', async () => {
        const { CodeLinesViewCore } = await import('./CodeLinesViewCore');
        let scrollY = 55;
        let inserted = false;
        const screen = await renderScreen(<CodeLinesViewCore lines={buildCodeLinesFromFile({ text: 'a\nb\nreading\nd' })} />, {
            createNodeMock: (element) => element.type === 'FlatList' ? {
                getNativeScrollRef: () => ({ measureInWindow: (success: (x: number, y: number) => void) => success(0, 0) }),
                scrollToOffset: ({ offset }: { offset: number }) => { scrollY = offset; },
                // Native list metrics can still describe the previous layout during commit.
                scrollToIndex: ({ index, viewOffset }: { index: number; viewOffset: number }) => { scrollY = index * 25 - viewOffset; },
            } : typeof (element.props as Record<string, unknown>).nativeID === 'string' ? {
                measureInWindow: (success: (x: number, y: number) => void) => {
                    const index = Number(String((element.props as Record<string, unknown>).nativeID).split(':').at(-1)) - 1;
                    const y = inserted && index > 0 ? 60 + (index - 1) * 25 : index * 25;
                    success(0, y - scrollY);
                },
            } : null,
        });
        await act(async () => {
            screen.findByType('FlatList').props.onScroll({ nativeEvent: { contentOffset: { y: scrollY } } });
            screen.findByType('FlatList').props.onViewableItemsChanged({ viewableItems: [{ index: 2 }] });
        });
        inserted = true;
        await act(async () => screen.tree.update(<CodeLinesViewCore lines={buildCodeLinesFromFile({ text: 'wrapped insertion\na\nb\nreading\nd' })} />));
        expect(scrollY).toBe(115);
    });

    it.each([{ tail: 'c\nreading', initial: 80 }, { tail: 'reading\nd', initial: 55 }])('preserves consecutive external refreshes at offset $initial', async ({ tail, initial }) => {
        const { CodeLinesViewCore } = await import('./CodeLinesViewCore');
        let scrollY = initial;
        const externalScrollView = {
            scrollRef: { current: { scrollTo: ({ y }: { y: number }) => { scrollY = y; } } },
            // Native host measurement boundary is supplied by createNodeMock.
            contentRef: { current: {} as View },
            offsetRef: { current: scrollY },
        };
        const screen = await renderScreen(<CodeLinesViewCore virtualized={false} externalScrollView={externalScrollView} lines={buildCodeLinesFromFile({ text: `a\nb\n${tail}` })} />, {
            createNodeMock: (element) => typeof (element.props as Record<string, unknown>).nativeID === 'string' ? {
                measureLayout: (_relative: unknown, success: (x: number, y: number, width: number, height: number) => void) => {
                    const index = Number(String((element.props as Record<string, unknown>).nativeID).split(':').at(-1)) - 1;
                    success(0, index * 25, 100, 25);
                },
            } : null,
        });
        await act(async () => {
            for (const row of screen.tree.root.findAll((node) => String(node.type) === 'View' && typeof node.props.nativeID === 'string')) row.props.onLayout?.();
        });
        await act(async () => screen.tree.update(<CodeLinesViewCore virtualized={false} externalScrollView={externalScrollView} lines={buildCodeLinesFromFile({ text: `inserted\na\nb\n${tail}` })} />));
        expect(scrollY).toBe(initial + 25);
        // A second refresh can commit before the native onScroll echo arrives.
        await act(async () => screen.tree.update(<CodeLinesViewCore virtualized={false} externalScrollView={externalScrollView} lines={buildCodeLinesFromFile({ text: `second\ninserted\na\nb\n${tail}` })} />));
        expect(scrollY).toBe(initial + 50);
    });

    it('retains the mapped passage when the native list first needs to measure the new target', async () => {
        const { CodeLinesViewCore } = await import('./CodeLinesViewCore');
        let visible: { index: number; viewOffset?: number; viewPosition?: number } = { index: 2 };
        let needsMeasurement = true;
        const screen = await renderScreen(<CodeLinesViewCore lines={buildCodeLinesFromFile({ text: 'a\nb\nreading\nd' })} />, {
            createNodeMock: (element) => element.type === 'FlatList' ? {
                scrollToOffset: () => {},
                scrollToIndex: (target: typeof visible) => {
                    if (needsMeasurement) {
                        needsMeasurement = false;
                        const onFailure = (element.props as Record<string, unknown>).onScrollToIndexFailed as (info: { index: number; averageItemLength: number }) => void;
                        onFailure({ index: target.index, averageItemLength: 22 });
                    } else visible = target;
                },
            } : null,
        });
        await act(async () => {
            screen.findByType('FlatList').props.onViewableItemsChanged({ viewableItems: [{ index: 2 }] });
        });
        await act(async () => screen.tree.update(<CodeLinesViewCore lines={buildCodeLinesFromFile({ text: 'inserted\na\nb\nreading\nd' })} />));
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
        expect(visible.index).toBe(3);
        expect(visible.viewOffset).toBe(0);
        expect(visible.viewPosition).toBeUndefined();
    });
});
