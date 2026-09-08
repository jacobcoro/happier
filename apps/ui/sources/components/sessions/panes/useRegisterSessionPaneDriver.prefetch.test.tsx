import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const rightPanelModuleLoaded = vi.fn();
const detailsPanelModuleLoaded = vi.fn();
const bottomPanelModuleLoaded = vi.fn();

vi.mock('@/components/appShell/panes/AppPaneProvider', () => {
    const ctx = {
        registerDriver: () => () => {},
    };
    return {
        useAppPaneContext: () => ctx,
        useOptionalAppPaneContext: () => ctx,
    };
});

vi.mock('./SessionRightPanel', () => {
    rightPanelModuleLoaded();
    return {
        SessionRightPanel: () => React.createElement('SessionRightPanel'),
    };
});

vi.mock('./SessionDetailsPanel', () => {
    detailsPanelModuleLoaded();
    return {
        SessionDetailsPanel: () => React.createElement('SessionDetailsPanel'),
    };
});

vi.mock('./bottom/SessionBottomPanel', () => {
    bottomPanelModuleLoaded();
    return {
        SessionBottomPanel: () => React.createElement('SessionBottomPanel'),
    };
});

describe('useRegisterSessionPaneDriver (module prefetch)', () => {
    it('does not trigger duplicate eager pane-module loads when the hook mounts', async () => {
        const { useRegisterSessionPaneDriver } = await import('./useRegisterSessionPaneDriver');
        rightPanelModuleLoaded.mockClear();
        detailsPanelModuleLoaded.mockClear();
        bottomPanelModuleLoaded.mockClear();

        const Probe = () => {
            useRegisterSessionPaneDriver('s1');
            return React.createElement('Probe');
        };

        await renderScreen(<Probe />);

        expect(rightPanelModuleLoaded).not.toHaveBeenCalled();
        expect(detailsPanelModuleLoaded).not.toHaveBeenCalled();
        expect(bottomPanelModuleLoaded).not.toHaveBeenCalled();
    });

    it('settles and reports a failed speculative module fetch', async () => {
        const mod = await import('./useRegisterSessionPaneDriver');
        const originalLoaders = [...mod.sessionPaneModulePrefetchLoaders];
        const failure = new TypeError('Failed to fetch');
        // The browser chunk fetch is an external boundary; preserve the real prefetch owner.
        const fetchModule = vi.fn<() => Promise<void>>().mockRejectedValue(failure);
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        mod.sessionPaneModulePrefetchLoaders.splice(0, originalLoaders.length, fetchModule);
        try {
            await expect(mod.prefetchSessionPaneModules()).resolves.toBeUndefined();
            expect(warning).toHaveBeenCalledWith(expect.any(String), failure);
        } finally {
            mod.sessionPaneModulePrefetchLoaders.splice(0, mod.sessionPaneModulePrefetchLoaders.length, ...originalLoaders);
            warning.mockRestore();
        }
    });

    it('prefetches lazily opened session pane views', async () => {
        const mod = await import('./useRegisterSessionPaneDriver');
        const loadSubagentDetails = vi.fn(async () => undefined);
        mod.sessionPaneModulePrefetchLoaders.splice(
            0,
            mod.sessionPaneModulePrefetchLoaders.length,
            loadSubagentDetails,
        );

        await mod.prefetchSessionPaneModules();

        expect(loadSubagentDetails).toHaveBeenCalledTimes(1);
    });
});
