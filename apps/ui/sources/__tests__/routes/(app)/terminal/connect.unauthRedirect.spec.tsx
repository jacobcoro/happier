import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { readReactNativeMmkvStubValues } from '@/dev/testkit/mocks/mmkv';
import { installTerminalRouteCommonModuleMocks } from './terminalRouteTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const replaceMock = vi.fn();
const upsertActivateAndSwitchServerMock = vi.fn(async (_params: { serverUrl: string; source: string; scope: string; refreshAuth?: unknown }) => true);
const getCredentialsMock = vi.fn(async () => null as null | { token: string; secret: string });
const refreshFromActiveServerMock = vi.fn(async () => {});
const authState = vi.hoisted(() => ({ isAuthenticated: false }));
let activeServerUrl = 'https://api.happier.dev';

installTerminalRouteCommonModuleMocks({
    router: async () =>
        createExpoRouterMock({
            router: { back: vi.fn(), replace: replaceMock, push: vi.fn(), setParams: vi.fn() },
            pathname: '/terminal/connect',
        }).module,
});

vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: () => ({ processAuthUrl: vi.fn(async () => {}), isLoading: false }),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: authState.isAuthenticated,
        credentials: null,
        refreshFromActiveServer: refreshFromActiveServerMock,
    }),
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentials: getCredentialsMock,
    },
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerUrl: () => activeServerUrl,
    getActiveServerSnapshot: () => ({
        serverId: 'active-server',
        serverUrl: activeServerUrl,
        activeShareableServerUrl: null,
        activeLocalRelayUrl: null,
        generation: 1,
    }),
}));

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    normalizeServerUrl: (value: string) => String(value ?? '').trim().replace(/\/+$/, ''),
    upsertActivateAndSwitchServer: upsertActivateAndSwitchServerMock,
}));

describe('TerminalConnectScreen unauthenticated redirect', () => {
    afterEach(() => {
        standardCleanup();
    });

    beforeEach(() => {
        vi.resetModules();
        vi.unmock('@/utils/path/terminalConnectUrl');
        authState.isAuthenticated = false;
        replaceMock.mockClear();
        upsertActivateAndSwitchServerMock.mockClear();
        getCredentialsMock.mockReset();
        getCredentialsMock.mockResolvedValue(null);
        refreshFromActiveServerMock.mockClear();
        activeServerUrl = 'https://api.happier.dev';
        (globalThis as any).window = {
            location: {
                hash: '#key=abc123&server=https%3A%2F%2Fcompany.example.test',
                pathname: '/terminal/connect',
                search: '',
                href: 'https://ui.example.test/terminal/connect#key=abc123&server=https%3A%2F%2Fcompany.example.test',
            },
            history: { replaceState: vi.fn() },
        };
    });

    it('stores pending connect and redirects to auth screen immediately', async () => {
        const Screen = (await import('@/app/(app)/terminal/connect')).default;

        await renderScreen(<Screen />);
        await act(async () => {});

        expect(readReactNativeMmkvStubValues()).toContainEqual(expect.stringContaining('abc123'));
        expect(upsertActivateAndSwitchServerMock).toHaveBeenCalledWith({
            serverUrl: 'https://company.example.test',
            source: 'url',
            scope: 'device',
            refreshAuth: refreshFromActiveServerMock,
        });
        expect(replaceMock).toHaveBeenCalledWith('/');
    });

    it('does not redirect while stored credentials are available but auth context is still hydrating', async () => {
        getCredentialsMock.mockResolvedValue({ token: 'token', secret: 'secret' });
        const Screen = (await import('@/app/(app)/terminal/connect')).default;

        const screen = await renderScreen(<Screen />);
        await act(async () => {});

        expect(screen.findByTestId('unauth-shell-route-terminal-connect')).not.toBeNull();
        expect(screen.findByTestId('terminal-connect-route-content')).not.toBeNull();
        expect(readReactNativeMmkvStubValues()).toContainEqual(expect.stringContaining('abc123'));
        expect(replaceMock).not.toHaveBeenCalled();
    });

    it('drops the unauthenticated shell when auth state becomes authenticated after mount', async () => {
        getCredentialsMock.mockResolvedValue({ token: 'token', secret: 'secret' });
        const Screen = (await import('@/app/(app)/terminal/connect')).default;

        const screen = await renderScreen(<Screen />);
        await act(async () => {});

        expect(screen.findByTestId('unauth-shell-route-terminal-connect')).not.toBeNull();

        authState.isAuthenticated = true;
        await screen.update(<Screen />);
        await act(async () => {});

        expect(screen.findAllByType('UnauthenticatedSplitShell' as never)).toHaveLength(0);
        expect(screen.findByTestId('terminal-connect-route-content')).not.toBeNull();
    });

    it('refreshes active-server credentials once before redirecting unauthenticated terminal connect', async () => {
        getCredentialsMock
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ token: 'token', secret: 'secret' });
        const Screen = (await import('@/app/(app)/terminal/connect')).default;

        await renderScreen(<Screen />);
        await act(async () => {});

        expect(refreshFromActiveServerMock).toHaveBeenCalledTimes(1);
        expect(replaceMock).not.toHaveBeenCalled();
    });

    it('honors loopback server overrides when redirecting terminal auth', async () => {
        const Screen = (await import('@/app/(app)/terminal/connect')).default;
        activeServerUrl = 'http://127.0.0.1:43005';
        (globalThis as any).window.location = {
            hash: '#key=abc123&server=http%3A%2F%2F127.0.0.1%3A3005',
            pathname: '/terminal/connect',
            search: '',
            href: 'https://ui.example.test/terminal/connect#key=abc123&server=http%3A%2F%2F127.0.0.1%3A3005',
        };

        await renderScreen(<Screen />);
        await act(async () => {});

        expect(readReactNativeMmkvStubValues()).toContainEqual(expect.stringContaining('abc123'));
        expect(upsertActivateAndSwitchServerMock).toHaveBeenCalledWith({
            serverUrl: 'http://127.0.0.1:3005',
            source: 'url',
            scope: 'device',
            refreshAuth: refreshFromActiveServerMock,
        });
        expect(replaceMock).toHaveBeenCalledWith('/');
    });
});
