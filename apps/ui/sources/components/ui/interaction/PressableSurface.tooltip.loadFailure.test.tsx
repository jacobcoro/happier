import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const loadAnchoredTooltipComponentMock = vi.hoisted(() => vi.fn());

vi.mock('@/components/ui/overlays/anchoredTooltipModuleLoader', () => ({
    loadAnchoredTooltipComponent: loadAnchoredTooltipComponentMock,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' }, View: 'View', Pressable: 'Pressable' });
});

class AppFailureProbe extends React.Component<React.PropsWithChildren, { failed: boolean }> {
    override state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    override render() { return this.state.failed ? React.createElement('AppFailed') : this.props.children; }
}

it('contains a tooltip chunk failure, reports it, and retries when focus follows the failed hover', async () => {
    const transportError = new TypeError('Failed to fetch');
    const LoadedTooltip = () => React.createElement('LoadedTooltip', { testID: 'loaded-tooltip' });
    // External browser module transport: keep the real trigger, failure containment, and retry lifecycle.
    loadAnchoredTooltipComponentMock
        .mockRejectedValueOnce(transportError)
        .mockResolvedValue(LoadedTooltip);
    const { PressableSurface } = await import('./PressableSurface');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onPress = vi.fn();
    try {
        const screen = await renderScreen(
            <AppFailureProbe>
                <PressableSurface testID="action" accessibilityLabel="Next file" webTooltip="Next file" onPress={onPress} />
            </AppFailureProbe>,
        );
        await act(async () => {
            screen.findByTestId('action')?.props.onHoverIn();
            await vi.dynamicImportSettled();
        });
        expect(screen.findByTestId('action')).toBeTruthy();
        expect(warning.mock.calls.flat().some((value) => value === transportError || (value instanceof Error && value.cause === transportError))).toBe(true);
        expect(loadAnchoredTooltipComponentMock).toHaveBeenCalledTimes(1);
        await screen.pressByTestIdAsync('action');
        expect(onPress).toHaveBeenCalledOnce();
        await act(async () => {
            screen.findByTestId('action')?.props.onFocus();
            await vi.dynamicImportSettled();
        });
        expect(loadAnchoredTooltipComponentMock).toHaveBeenCalledTimes(2);
        expect(screen.findByTestId('loaded-tooltip')).toBeTruthy();
        expect(screen.findByTestId('action')).toBeTruthy();
    } finally {
        loadAnchoredTooltipComponentMock.mockReset();
        warning.mockRestore();
        errorLog.mockRestore();
    }
});
