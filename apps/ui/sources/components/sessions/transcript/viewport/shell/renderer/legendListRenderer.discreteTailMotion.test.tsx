import * as React from 'react';
import { AccessibilityInfo, Platform } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';
import { createWebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import { resolveMainTranscriptListShellFrame } from '../transcriptListShellCapabilities';
import { legendListRenderer } from './legendListRenderer';
import type { TranscriptListShellRef } from './types';

/**
 * Discrete tail motion is the only ANIMATED write that reaches the renderer's tail
 * command owner: every steady-maintenance and correction write arrives with
 * `animated: false` (see the pin-bottom drivers), and Legend's own
 * `maintainScrollAtEnd` is pinned to `animated: false`. These tests hold that
 * boundary — the one animated transition honors the OS reduced-motion preference,
 * and a genuine user drag takes the tail back from it.
 */

let capturedLegendListProps: any = null;
let assignedLegendRef: any = null;
let mountedWebDomObservation: ReturnType<typeof createWebDomScrollObservation>;
const originalPlatformOS = Platform.OS;

/**
 * `AccessibilityInfo` is the genuine OS boundary behind the reduced-motion
 * preference. The canonical hook attaches ONE process-wide listener on first read,
 * so the captured listener is kept for the whole file and used to drive the
 * preference per test.
 */
const reduceMotionListeners: Array<(enabled: boolean) => void> = [];

function setPlatformOS(value: typeof Platform.OS): void {
    Object.defineProperty(Platform, 'OS', { configurable: true, value });
}

function getShellRef<TItem>(
    ref: React.RefObject<TranscriptListShellRef<TItem> | null>,
): TranscriptListShellRef<TItem> {
    expect(ref.current).not.toBeNull();
    const target = ref.current!;
    return new Proxy(target, {
        get(current, property, receiver) {
            const value = Reflect.get(current, property, receiver);
            if (typeof value !== 'function') return value;
            return (...args: unknown[]) => {
                let result: unknown;
                act(() => {
                    result = value.apply(current, args);
                });
                return result;
            };
        },
    });
}

vi.mock('@legendapp/list/react-native', () => ({
    LegendList: React.forwardRef((props: any, ref: any) => {
        capturedLegendListProps = props;
        const data = Array.isArray(props.data) ? props.data : [];
        const instance = React.useMemo(() => ({
            cancelScroll: vi.fn(),
            clearCaches: vi.fn(),
            getNativeScrollRef: vi.fn(),
            getScrollableNode: vi.fn(() => null),
            getScrollResponder: vi.fn(),
            getState: vi.fn(() => ({
                end: Math.max(0, data.length - 1),
                isAtEnd: true,
                isNearEnd: true,
                isWithinMaintainScrollAtEndThreshold: true,
                scroll: 0,
                scrollLength: 0,
                start: 0,
                listen: () => () => undefined,
            })),
            scrollToEnd: vi.fn(() => Promise.resolve()),
            scrollToIndex: vi.fn(() => Promise.resolve()),
            scrollToOffset: vi.fn(() => Promise.resolve()),
        }), []);
        if (typeof ref === 'function') ref(instance);
        else if (ref && typeof ref === 'object') ref.current = instance;
        assignedLegendRef = instance;
        return React.createElement(
            'LegendList',
            props,
            props.ListHeaderComponent ?? null,
            data.map((item: any, index: number) => React.createElement(
                'LegendListItem',
                { key: props.keyExtractor?.(item, index) ?? index },
                props.renderItem?.({ item, index }),
            )),
            props.ListFooterComponent ?? null,
        );
    }),
}));

async function mountNativeTranscript() {
    const listRef = React.createRef<TranscriptListShellRef<{ id: string }>>();
    const Renderer = legendListRenderer.Component;
    await renderScreen(
        <Renderer
            webDomObservation={mountedWebDomObservation}
            ref={listRef}
            data={Array.from({ length: 4 }, (_value, index) => ({ id: `row-${index}` }))}
            dataKey="session-discrete-tail-motion"
            keyExtractor={(item: { id: string }) => item.id}
            renderItem={({ item }: { item: { id: string } }) => React.createElement('Row', { id: item.id })}
            frame={resolveMainTranscriptListShellFrame({
                legendInitialScrollAtEnd: true,
                nativeID: 'legend-main-native-id',
                platformOS: 'ios',
            })}
        />,
    );
    return listRef;
}

function publishReduceMotion(enabled: boolean): void {
    act(() => {
        for (const listener of [...reduceMotionListeners]) listener(enabled);
    });
}

describe('legendListRenderer discrete tail motion', () => {
    beforeEach(() => {
        setPlatformOS('ios');
        capturedLegendListProps = null;
        assignedLegendRef = null;
        mountedWebDomObservation = createWebDomScrollObservation();
        vi.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
        vi.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation(((
            event: string,
            listener: (enabled: boolean) => void,
        ) => {
            if (event === 'reduceMotionChanged') reduceMotionListeners.push(listener);
            return { remove: () => undefined };
        }) as never);
    });

    afterEach(() => {
        setPlatformOS(originalPlatformOS);
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('keeps the discrete tail transition animated while reduced motion is off', async () => {
        const listRef = await mountNativeTranscript();
        publishReduceMotion(false);

        getShellRef(listRef).scrollToEnd?.({ animated: true });

        expect(assignedLegendRef.scrollToEnd).toHaveBeenCalledWith({ animated: true });
    });

    it('makes the discrete tail transition instant when the OS reduced-motion preference is set', async () => {
        const listRef = await mountNativeTranscript();
        publishReduceMotion(true);

        getShellRef(listRef).scrollToEnd?.({ animated: true });

        expect(assignedLegendRef.scrollToEnd).toHaveBeenCalledWith({ animated: false });
    });

    it('never animates a correction: unanimated tail writes stay instant under either preference', async () => {
        const listRef = await mountNativeTranscript();
        publishReduceMotion(false);

        // Steady maintenance and every correction reach this owner unanimated.
        getShellRef(listRef).scrollToEnd?.({ animated: false });
        expect(assignedLegendRef.scrollToEnd).toHaveBeenLastCalledWith({ animated: false });

        publishReduceMotion(true);
        getShellRef(listRef).scrollToEnd?.({ animated: false });
        expect(assignedLegendRef.scrollToEnd).toHaveBeenLastCalledWith({ animated: false });

        // Legend's continuous end-maintenance is never animated by this transition.
        expect(capturedLegendListProps.maintainScrollAtEnd).toMatchObject({ animated: false });
    });

    it('lets a user drag cancel the discrete tail transition instead of fighting it', async () => {
        const listRef = await mountNativeTranscript();
        publishReduceMotion(false);

        getShellRef(listRef).scrollToEnd?.({ animated: true });
        // The command latched tail ownership, so Legend maintains the end.
        expect(capturedLegendListProps.maintainScrollAtEnd).toMatchObject({ animated: false });

        act(() => {
            capturedLegendListProps.onScrollBeginDrag({ nativeEvent: { contentOffset: { x: 0, y: 400 } } });
        });

        // User input wins: tail ownership is released, so nothing re-pins mid-gesture.
        expect(capturedLegendListProps.maintainScrollAtEnd).toBe(false);
    });
});
