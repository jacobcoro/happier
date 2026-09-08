import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as LegendNative from '@legendapp/list/react-native';
import { LegendList } from '@legendapp/list/react-native';
import { Platform } from 'react-native';

import {
    assertShippedNativeLegendRuntime,
    createShippedNativeNodeMock,
    readShippedNativeModuleFacts,
    type ShippedNativeNodeMock,
} from '@/dev/testkit/legend/shippedNativeLegendRuntime';

/**
 * Characterizes the SHIPPED NATIVE tail command - the external contract the transcript's
 * bottom-pin owner (`createTranscriptViewportController`) depends on when it resolves a bottom
 * intent as a settled write instead of an animation.
 *
 * Native-exclusive by construction: the web build assigns its own scroll position FROM the DOM's
 * `scrollTop` inside the same statement it writes, so it has no equivalent open transaction. This
 * lane executes `react-native.mjs` with `Platform.OS === 'ios'` and New Architecture on; the web
 * build cannot express the contract at all.
 *
 * Contract basis: `@legendapp/list@3.3.3`, `react-native.mjs#doScrollTo` (the unanimated branch
 * assigns `state.scroll = offset` and runs the completion fallback inline; the animated branch does
 * neither and leaves the target armed for a native scroll event to retire).
 *
 * What this lane does NOT cover: there is no real `UIScrollView` here, so the platform's own
 * behaviour during an animated `setContentOffset` - clamping against a content size that changes
 * mid-flight - is NOT simulated. That is the measured field defect; this test covers only the
 * JS-side window the animated form opens for it.
 */

type Row = Readonly<{ id: string }>;

const ROW_HEIGHT = 100;
const VIEWPORT_HEIGHT = 300;
const ROW_COUNT = 20;

type LegendTailHandle = Readonly<{
    cancelScroll?: () => void;
    getState: () => Readonly<{ scroll: number }>;
    scrollToIndex: (options: Readonly<{ index: number; animated?: boolean }>) => Promise<unknown>;
    scrollToEnd: (options?: Readonly<{ animated?: boolean }>) => Promise<unknown>;
}>;

type MountedList = Readonly<{
    handle: LegendTailHandle;
    nodes: ShippedNativeNodeMock;
    screen: ReactTestRenderer;
}>;

let mounted: MountedList | null = null;

afterEach(() => {
    if (mounted) {
        const current = mounted;
        act(() => current.screen.unmount());
        mounted = null;
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
});

function buildRows(count: number): Row[] {
    return Array.from({ length: count }, (_value, index) => ({ id: `row-${index}` }));
}

async function mountList(options?: Readonly<{ initialAtEnd?: boolean; cancelSilentRetry?: boolean }>): Promise<MountedList> {
    const nodes = createShippedNativeNodeMock({ rowHeight: ROW_HEIGHT, viewportHeight: VIEWPORT_HEIGHT });
    const ref = React.createRef<LegendTailHandle>();
    if (options?.cancelSilentRetry) {
        const scrollTo = nodes.scroller.scrollTo;
        vi.spyOn(nodes.scroller, 'scrollTo').mockImplementation((write) => {
            scrollTo(write);
            // The actual platform boundary reports the initial retry's one-pixel nudge.
            // User takeover can run before its separately queued return-to-target frame.
            if (write.y === ROW_COUNT * ROW_HEIGHT - VIEWPORT_HEIGHT - 1) ref.current?.cancelScroll?.();
        });
    }
    let screen: ReactTestRenderer | null = null;
    await act(async () => {
        screen = create(
            <LegendList
                data={buildRows(ROW_COUNT)}
                estimatedItemSize={ROW_HEIGHT}
                initialScrollAtEnd={options?.initialAtEnd}
                keyExtractor={(item: Row) => item.id}
                recycleItems={false}
                ref={ref as never}
                renderItem={({ item }: { item: Row }) => <React.Fragment>{item.id}</React.Fragment>}
            />,
            { createNodeMock: nodes.createNodeMock },
        );
    });
    const created = screen as unknown as ReactTestRenderer;
    await act(async () => {
        created.root.findByType('ScrollView' as never).props.onLayout({
            nativeEvent: { layout: { height: VIEWPORT_HEIGHT, width: 800, x: 0, y: 0 } },
        });
        await Promise.resolve();
    });
    const handle = ref.current;
    if (!handle) throw new Error('The shipped native LegendList did not expose its imperative handle.');
    mounted = { handle, nodes, screen: created };
    return mounted;
}

async function flushFrames(count: number): Promise<void> {
    for (let index = 0; index < count; index++) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    }
}

async function commandTail(list: MountedList, animated: boolean): Promise<void> {
    await act(async () => {
        void list.handle.scrollToEnd({ animated });
        await Promise.resolve();
    });
    await flushFrames(4);
}

describe('shipped native Legend tail command', () => {
    it.skipIf(Platform.OS !== 'android').each([false, true])('respects cancellation=%s between the silent initial nudge and its delayed retry', async (cancelSilentRetry) => {
        vi.useFakeTimers();
        const list = await mountList({ initialAtEnd: true, cancelSilentRetry });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(3_000);
        });
        const target = ROW_COUNT * ROW_HEIGHT - VIEWPORT_HEIGHT;
        const nudgeIndex = list.nodes.scroller.scrollWrites.findIndex((write) => write.y === target - 1);
        expect(nudgeIndex, JSON.stringify(list.nodes.scroller.scrollWrites)).toBeGreaterThanOrEqual(0);
        const laterWrites = list.nodes.scroller.scrollWrites.slice(nudgeIndex + 1);
        if (cancelSilentRetry) expect(laterWrites).toEqual([]);
        else expect(laterWrites.some((write) => write.y === target)).toBe(true);
    });

    it('retires an in-flight animated command without dispatching a replacement movement', async () => {
        const list = await mountList();
        let settled = false;
        await act(async () => {
            void list.handle.scrollToEnd({ animated: true }).then(() => { settled = true; });
        });
        await flushFrames(4);
        expect(settled).toBe(false);
        expect(list.nodes.scroller.scrollWrites.length).toBeGreaterThan(0);
        const writeCount = list.nodes.scroller.scrollWrites.length;
        await act(async () => {
            list.handle.cancelScroll?.();
            await Promise.resolve();
        });
        expect(settled).toBe(true);
        await flushFrames(4);
        expect(list.nodes.scroller.scrollWrites.slice(writeCount)).toEqual([]);
    });

    it.each(['end', 'index'] as const)('revokes a queued %s command without moving and resolves its promise', async (kind) => {
        const list = await mountList();
        await flushFrames(4);
        const writeCount = list.nodes.scroller.scrollWrites.length;
        let settled = false;
        await act(async () => {
            // End waits for the commit; a not-yet-materialized index waits for readiness.
            const command = kind === 'end'
                ? list.handle.scrollToEnd({ animated: false })
                : list.handle.scrollToIndex({ index: ROW_COUNT + 5, animated: false });
            void command.then(() => { settled = true; });
            list.handle.cancelScroll?.();
            await Promise.resolve();
        });
        await flushFrames(4);
        expect(settled).toBe(true);
        expect(list.nodes.scroller.scrollWrites.slice(writeCount)).toEqual([]);
        // Cancellation is not disposal: later commands must still work.
        await commandTail(list, false);
        expect(list.nodes.scroller.scrollWrites.at(-1)?.y).toBe(ROW_COUNT * ROW_HEIGHT - VIEWPORT_HEIGHT);
    });

    it('settles its own scroll position when the tail command is unanimated', async () => {
        const list = await mountList();
        assertShippedNativeLegendRuntime(list.screen, readShippedNativeModuleFacts(LegendNative, Platform));

        await commandTail(list, false);

        const write = list.nodes.scroller.scrollWrites.at(-1);
        // A real end target, not 0 - otherwise "settled" and "unreconciled" would be the same
        // number and neither test below would discriminate anything.
        expect(write).toMatchObject({ animated: false, y: ROW_COUNT * ROW_HEIGHT - VIEWPORT_HEIGHT });
        // The whole point of the unanimated form: the list's own position is already the commanded
        // offset when the call returns, so no later scroll event has to arrive for it to be right.
        expect(list.handle.getState().scroll).toBe(write?.y);
    });

    it('leaves its scroll position unreconciled while an animated tail command is in flight', async () => {
        const list = await mountList();
        assertShippedNativeLegendRuntime(list.screen, readShippedNativeModuleFacts(LegendNative, Platform));

        await commandTail(list, true);

        const write = list.nodes.scroller.scrollWrites.at(-1);
        expect(write).toMatchObject({ animated: true, y: ROW_COUNT * ROW_HEIGHT - VIEWPORT_HEIGHT });
        // Same command, same target, no native scroll event delivered in either case - yet here the
        // list still believes it is where it started. That gap is the window an animated pin holds
        // open while content keeps hydrating underneath it, and it is why the transcript's bottom
        // intent resolves unanimated.
        expect(list.handle.getState().scroll).not.toBe(write?.y);
        expect(list.handle.getState().scroll).toBe(0);
    });
});
