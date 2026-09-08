import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { SegmentedTab } from './SegmentedTabBar';
import { installNavigationCommonModuleMocks } from './navigationTestHelpers';
import { renderScreen } from '@/dev/testkit/render/renderScreen';


(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installNavigationCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            I18nManager: { isRTL: false },
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        });
    },
});

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});


const TABS: ReadonlyArray<SegmentedTab<'alpha' | 'beta' | 'gamma'>> = [
    { id: 'alpha', label: 'Alpha' },
    { id: 'beta', label: 'Beta' },
    { id: 'gamma', label: 'Gamma' },
];

type RenderedScreen = Awaited<ReturnType<typeof renderScreen>>;

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!Array.isArray(style)) {
        return (style ?? {}) as Record<string, unknown>;
    }

    return style.reduce<Record<string, unknown>>((acc, entry) => ({
        ...acc,
        ...(entry ?? {}),
    }), {});
}

function requireTab(screen: RenderedScreen, testID: string) {
    const tab = screen.findByTestId(testID);
    expect(tab).toBeTruthy();
    return tab!;
}

function requireTabLabel(screen: RenderedScreen, testID: string): string {
    const tab = requireTab(screen, testID);
    const labelNode = tab.findByType('Text' as never);
    return labelNode.props.children;
}

describe('SegmentedTabBar', () => {
    it('moves selection and host focus with arrows, Home and End through a single tab stop', async () => {
        const listeners = new Map<string, (event: unknown) => void>();
        vi.stubGlobal('document', { addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener) });
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        let focused: string | undefined;
        function Harness() {
            const [active, setActive] = React.useState<'alpha' | 'beta' | 'gamma'>('alpha');
            return <SegmentedTabBar tabs={TABS} activeTabId={active} onSelectTab={setActive} testIDPrefix="seg" />;
        }
        const screen = await renderScreen(<Harness />, {
            createNodeMock: (element) => {
                const props = element.props;
                const testID = typeof props === 'object' && props !== null && 'testID' in props
                    && typeof props.testID === 'string' ? props.testID : undefined;
                return { focus: () => { focused = testID; } };
            },
        });
        expect(requireTab(screen, 'seg:alpha').props.tabIndex).toBe(0);
        expect(requireTab(screen, 'seg:beta').props.tabIndex).toBe(-1);
        for (const [from, key, to] of [
            ['alpha', 'ArrowLeft', 'gamma'],
            ['gamma', 'ArrowRight', 'alpha'],
            ['alpha', 'End', 'gamma'],
            ['gamma', 'Home', 'alpha'],
            ['alpha', 'ArrowRight', 'beta'],
        ]) {
            const preventDefault = vi.fn();
            await act(async () => requireTab(screen, `seg:${from}`).props.onKeyDown({ key, preventDefault }));
            expect(preventDefault).toHaveBeenCalled();
            expect(focused).toBe(`seg:${to}`);
            expect(requireTab(screen, `seg:${to}`).props.accessibilityState.selected).toBe(true);
            expect(requireTab(screen, `seg:${to}`).props.tabIndex).toBe(0);
            expect(requireTab(screen, `seg:${from}`).props.tabIndex).toBe(-1);
        }
        const preventDefault = vi.fn();
        await act(async () => requireTab(screen, 'seg:beta').props.onKeyDown({ key: 'Tab', preventDefault }));
        expect(preventDefault).not.toHaveBeenCalled();
        await act(async () => {
            listeners.get('keydown')?.({ key: 'Tab' });
            requireTab(screen, 'seg:beta').props.onFocus();
        });
        expect(flattenStyle(screen.findHostByTestId('seg:beta:focus-ring')?.props.style).opacity).toBe(1);
        await act(async () => listeners.get('pointerdown')?.({}));
        expect(flattenStyle(screen.findHostByTestId('seg:beta:focus-ring')?.props.style).opacity).toBe(0);
        const { I18nManager, Platform } = await import('react-native');
        I18nManager.isRTL = true;
        await act(async () => requireTab(screen, 'seg:beta').props.onKeyDown({ key: 'ArrowRight', preventDefault: vi.fn() }));
        expect(requireTab(screen, 'seg:alpha').props.accessibilityState.selected).toBe(true);
        I18nManager.isRTL = false;
        await act(async () => requireTab(screen, 'seg:beta').props.onKeyDown({ key: ' ', preventDefault: vi.fn() }));
        expect(requireTab(screen, 'seg:beta').props.accessibilityState.selected).toBe(true);
        const platformOS = Platform.OS;
        Platform.OS = 'ios';
        const nativeScreen = await renderScreen(<Harness />);
        expect(requireTab(nativeScreen, 'seg:alpha').props.tabIndex).toBeUndefined();
        expect(requireTab(nativeScreen, 'seg:alpha').props.onKeyDown).toBeUndefined();
        await nativeScreen.pressByTestIdAsync('seg:beta');
        expect(requireTab(nativeScreen, 'seg:beta').props.accessibilityState.selected).toBe(true);
        Platform.OS = platformOS;
        vi.unstubAllGlobals();
    });

    it('renders all tab labels', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const screen = await renderScreen(
            <SegmentedTabBar tabs={TABS} activeTabId="alpha" onSelectTab={() => {}} testIDPrefix="seg" />,
        );

        expect(requireTabLabel(screen, 'seg:alpha')).toBe('Alpha');
        expect(requireTabLabel(screen, 'seg:beta')).toBe('Beta');
        expect(requireTabLabel(screen, 'seg:gamma')).toBe('Gamma');
    });

    it('calls onSelectTab with the tab id when a tab is pressed', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const onSelectTab = vi.fn();

        const screen = await renderScreen(
            <SegmentedTabBar tabs={TABS} activeTabId="alpha" onSelectTab={onSelectTab} testIDPrefix="seg" />,
        );

        screen.pressByTestId('seg:beta');
        expect(onSelectTab).toHaveBeenCalledTimes(1);
        expect(onSelectTab).toHaveBeenCalledWith('beta');

        screen.pressByTestId('seg:gamma');
        expect(onSelectTab).toHaveBeenCalledTimes(2);
        expect(onSelectTab).toHaveBeenCalledWith('gamma');
    });

    it('sets testIDs when testIDPrefix is provided', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const screen = await renderScreen(
            <SegmentedTabBar tabs={TABS} activeTabId="alpha" onSelectTab={() => {}} testIDPrefix="seg" />,
        );

        expect(screen.findByTestId('seg:alpha')?.props.testID).toBe('seg:alpha');
        expect(screen.findByTestId('seg:beta')?.props.testID).toBe('seg:beta');
        expect(screen.findByTestId('seg:gamma')?.props.testID).toBe('seg:gamma');
    });

    it('does not set testIDs when testIDPrefix is omitted', async () => {
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const screen = await renderScreen(<SegmentedTabBar tabs={TABS} activeTabId="alpha" onSelectTab={() => {}} />);

        for (const tabId of ['alpha', 'beta', 'gamma'] as const) {
            expect(screen.findByTestId(tabId)).toBeNull();
        }
    });

    it('applies active styles only to the active tab', async () => {
        const { lightTheme: theme } = await import('@/theme');
        const { SegmentedTabBar } = await import('./SegmentedTabBar');
        const screen = await renderScreen(
            <SegmentedTabBar tabs={TABS} activeTabId="beta" onSelectTab={() => {}} testIDPrefix="seg" />,
        );

        // Tabs should expose the selected state for accessibility (web: aria-selected).
        expect(screen.findByTestId('seg:beta')?.props.accessibilityRole).toBe('tab');
        expect(screen.findByTestId('seg:beta')?.props.accessibilityState).toEqual({ selected: true });
        expect(screen.findByTestId('seg:beta')?.props['aria-selected']).toBe(true);
        expect(screen.findByTestId('seg:alpha')?.props.accessibilityRole).toBe('tab');
        expect(screen.findByTestId('seg:alpha')?.props.accessibilityState).toEqual({ selected: false });
        expect(screen.findByTestId('seg:alpha')?.props['aria-selected']).toBe(false);
        expect(screen.findByTestId('seg:gamma')?.props.accessibilityRole).toBe('tab');
        expect(screen.findByTestId('seg:gamma')?.props.accessibilityState).toEqual({ selected: false });
        expect(screen.findByTestId('seg:gamma')?.props['aria-selected']).toBe(false);

        // The active tab ("beta") should include the tabActive background color.
        const activeFlat = flattenStyle(screen.findByTestId('seg:beta')?.props.style);
        expect(activeFlat.backgroundColor).toBe(theme.colors.surface.base);
        expect(screen.findByTestId('seg:beta')?.findByType('LinearGradient' as never).props.colors).toEqual(
            theme.colors.segmentedControl.activeGradient?.colors,
        );

        // Inactive tabs should NOT have the active background color.
        for (const testID of ['seg:alpha', 'seg:gamma'] as const) {
            expect(flattenStyle(screen.findByTestId(testID)?.props.style).backgroundColor).not.toBe(theme.colors.surface.base);
        }

        // The active tab's label should use the active text color.
        const activeLabelFlat = flattenStyle(screen.findByTestId('seg:beta')?.findByType('Text' as never).props.style);
        expect(activeLabelFlat.color).toBe(theme.colors.text.primary);
        expect(activeLabelFlat.fontWeight).toBe('600');

        // Inactive labels should use the secondary text color.
        for (const testID of ['seg:alpha', 'seg:gamma'] as const) {
            expect(flattenStyle(screen.findByTestId(testID)?.findByType('Text' as never).props.style).color).toBe(
                theme.colors.text.secondary,
            );
        }
    });
});
