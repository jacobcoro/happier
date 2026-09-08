import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionPaneLazyLoader } from './SessionPaneLazyLoader';
import { createDeferred, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                                                    View: (props: any) => React.createElement('View', props, props.children),
                                                                    Pressable: (props: any) => React.createElement('Pressable', props, props.children),
                                                                    ActivityIndicator: (props: any) => React.createElement('ActivityIndicator', props),
                                                                }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

class AppFailureProbe extends React.Component<React.PropsWithChildren, { failed: boolean }> {
    override state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    override render() { return this.state.failed ? React.createElement('AppFailed') : this.props.children; }
}

describe('SessionPaneLazyLoader', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('contains a details chunk fetch failure in the pane and retries without losing the surrounding app', async () => {
        // Model the external browser chunk transport, not file-details domain behavior.
        vi.doMock('@/components/sessions/files/views/SessionFileDetailsView', () => {
            throw new TypeError('Failed to fetch');
        });
        const { SessionFileDetailsViewForPanel } = await import('./SessionDetailsPanelDetailViews');
        const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            const screen = await renderScreen(
                <AppFailureProbe>
                    {React.createElement('RetainedApp', { testID: 'retained-app' })}
                    <React.Suspense fallback={React.createElement('Loading')}>
                        <SessionFileDetailsViewForPanel sessionId="s1" scopeId="session:s1" filePath="README.md" />
                    </React.Suspense>
                </AppFailureProbe>,
            );
            await act(async () => { await vi.dynamicImportSettled(); });
            expect(screen.findByTestId('session-file-details-loading-error')).toBeTruthy();
            expect(screen.findByTestId('retained-app')).toBeTruthy();
            vi.doMock('@/components/sessions/files/views/SessionFileDetailsView', () => ({
                SessionFileDetailsView: () => React.createElement('LoadedFileDetails', { testID: 'loaded-file-details' }),
            }));
            await pressTestInstanceAsync(screen.findByProps({ accessibilityRole: 'button' }), 'retry details');
            await act(async () => { await vi.dynamicImportSettled(); });
            expect(screen.findByTestId('loaded-file-details')).toBeTruthy();
            expect(screen.findByTestId('retained-app')).toBeTruthy();
        } finally {
            vi.doUnmock('@/components/sessions/files/views/SessionFileDetailsView');
            errorLog.mockRestore();
        }
    });

    it('keeps loading while a slow pane module is still pending and renders once it resolves', async () => {
        const LoadedPane = () => React.createElement('LoadedPane');
        const deferred = createDeferred<React.ComponentType<Record<string, never>>>();
        const load = vi.fn(() => deferred.promise);

        const screen = await renderScreen(
            <SessionPaneLazyLoader
                testID="session-pane-loader"
                load={load}
                props={{}}
            />,
        );

        expect(screen.findByTestId('session-pane-loader')).toBeTruthy();
        expect(screen.getTextContent()).toContain('common.loading');
        expect(load).toHaveBeenCalledTimes(1);

        await act(async () => {
            deferred.resolve(LoadedPane);
        });

        expect(screen.findByType(LoadedPane)).toBeTruthy();
    });

    it('shows retry UI after a rejected load and recovers when the user retries', async () => {
        const LoadedPane = () => React.createElement('LoadedPane');
        const load = vi.fn()
            .mockRejectedValueOnce(new Error('module load failed'))
            .mockResolvedValueOnce(LoadedPane);

        const screen = await renderScreen(
            <SessionPaneLazyLoader
                testID="session-pane-loader"
                load={load}
                props={{}}
            />,
        );

        expect(screen.findByTestId('session-pane-loader-error')).toBeTruthy();
        expect(screen.getTextContent()).toContain('common.error');
        expect(screen.getTextContent()).toContain('common.retry');

        const retryButton = screen.findByProps({ accessibilityRole: 'button' });
        await pressTestInstanceAsync(retryButton, 'session-pane-loader retry button');

        expect(load).toHaveBeenCalledTimes(2);
        expect(screen.findByType(LoadedPane)).toBeTruthy();
    });
});
