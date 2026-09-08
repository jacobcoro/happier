/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const { View, Text, ScrollView } = await import('react-native');
    const mock = createReanimatedModuleMock();
    return { ...mock, default: { ...mock.default, View, Text, ScrollView }, View, Text, ScrollView };
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('PressableSurface web tooltip', () => {
    it.each(['button', 'text'] as const)('reveals a portaled %s tooltip on hover and keyboard focus without moving focus', async (role) => {
        vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1024);
        vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(768);
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0));
        vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
        const { PressableSurface } = await import('./PressableSurface');
        await import('../overlays/AnchoredTooltip');
        // jsdom has no layout engine; the browser boundary supplies measured tooltip content.
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 20, 200, 28));
        const container = document.createElement('div');
        container.style.overflow = 'hidden';
        container.style.height = '28px';
        document.body.appendChild(container);
        const root = createRoot(container);
        try {
            await act(async () => {
                root.render(<PressableSurface accessibilityRole={role} testID="trigger" accessibilityLabel="Next file" webTooltip="Next file" />);
            });
            const trigger = container.querySelector<HTMLElement>('[data-testid="trigger"]');
            if (!trigger) throw new Error('Missing trigger');
            vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 20, 28, 28));
            expect(document.querySelector('[role="tooltip"]')).toBeNull();
            await act(async () => { trigger.dispatchEvent(new MouseEvent(window.PointerEvent != null ? 'pointerenter' : 'mouseenter', { bubbles: true })); });
            await vi.waitFor(() => {
                const tooltip = document.querySelector('[role="tooltip"]');
                expect(tooltip?.textContent).toBe('Next file');
                expect(container.contains(tooltip)).toBe(false);
                for (let node = tooltip; node instanceof HTMLElement; node = node.parentElement) {
                    const style = window.getComputedStyle(node);
                    expect(style.opacity, `${node.outerHTML.slice(0, 220)} PARENT ${node.parentElement?.outerHTML.slice(0, 450)}`).not.toBe('0');
                    expect(style.display).not.toBe('none');
                    expect(style.visibility).not.toBe('hidden');
                }
            }, { timeout: 10000 });
            expect(document.activeElement).not.toBe(trigger);
            await act(async () => { trigger.dispatchEvent(new MouseEvent(window.PointerEvent != null ? 'pointerleave' : 'mouseleave', { bubbles: true })); });
            await vi.waitFor(() => expect(document.querySelector('[role="tooltip"]')).toBeNull());
            await act(async () => {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
                trigger.focus();
            });
            await vi.waitFor(() => expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Next file'));
            expect(document.activeElement).toBe(trigger);
            await act(async () => { trigger.blur(); });
            await vi.waitFor(() => expect(document.querySelector('[role="tooltip"]')).toBeNull());
        } finally {
            await act(async () => root.unmount());
            container.remove();
            vi.restoreAllMocks();
            vi.unstubAllGlobals();
        }
    });
});
