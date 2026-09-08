import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StorageState } from '@/sync/store/types';

async function importFresh() {
    vi.resetModules();
    return await import('./pendingTerminalConnect');
}

async function activateServerAccount(serverUrl: string, accountId: string) {
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    const { createServerAccountScope } = await import('@/sync/domains/scope/serverAccountScope');
    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');

    const server = upsertAndActivateServer({
        serverUrl,
        source: 'manual',
        scope: 'device',
        replaceEquivalentStoredUrl: true,
    });
    const scope = createServerAccountScope(server.id, accountId);
    expect(scope).not.toBeNull();
    registerStorageStateReader(() => ({ profileScope: scope } as unknown as StorageState));
}

async function activateServerWithoutAccount(serverUrl: string) {
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
    upsertAndActivateServer({
        serverUrl,
        source: 'manual',
        scope: 'device',
        replaceEquivalentStoredUrl: true,
    });
    registerStorageStateReader(() => ({ profileScope: null } as unknown as StorageState));
}

describe('pendingTerminalConnect', () => {
    afterEach(async () => {
        const { clearPendingTerminalConnect } = await importFresh();
        clearPendingTerminalConnect();
        vi.restoreAllMocks();
    });

    it('round-trips a pending terminal connect payload', async () => {
        const now = 1_700_000_000_000;
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const { setPendingTerminalConnect, getPendingTerminalConnect } = await importFresh();

        await activateServerAccount('https://stack.example.test', 'account-a');
        expect(getPendingTerminalConnect()).toBeNull();

        setPendingTerminalConnect({
            publicKeyB64Url: 'abcDEF_123-zzz',
            serverUrl: 'https://stack.example.test',
            pairing: {
                secretB64Url: 'pairing-secret',
                createdAtMs: now,
                expiresAtMs: now + 61_000,
            },
        });

        expect(getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'abcDEF_123-zzz',
            serverUrl: 'https://stack.example.test',
            pairing: {
                secretB64Url: 'pairing-secret',
                createdAtMs: now,
                expiresAtMs: now + 61_000,
            },
        });
    });

    it('expires stale pending payloads', async () => {
        const now = 1_700_000_000_000;
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const { setPendingTerminalConnect, getPendingTerminalConnect } = await importFresh();

        await activateServerAccount('https://stack.example.test', 'account-a');
        setPendingTerminalConnect({
            publicKeyB64Url: 'abcDEF_123-zzz',
            serverUrl: 'https://stack.example.test',
        });
        expect(getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'abcDEF_123-zzz',
            serverUrl: 'https://stack.example.test',
        });

        vi.spyOn(Date, 'now').mockReturnValue(now + 60 * 60 * 1000);
        expect(getPendingTerminalConnect()).toBeNull();
    });

    it('keeps pending payloads isolated by active server', async () => {
        const { setPendingTerminalConnect, getPendingTerminalConnect, clearPendingTerminalConnect } = await importFresh();

        await activateServerAccount('https://server-a.example.test', 'account-a');
        clearPendingTerminalConnect();
        setPendingTerminalConnect({
            publicKeyB64Url: 'key-a',
            serverUrl: 'https://server-a.example.test',
        });

        await activateServerAccount('https://server-b.example.test', 'account-a');
        clearPendingTerminalConnect();
        expect(getPendingTerminalConnect()).toBeNull();
        setPendingTerminalConnect({
            publicKeyB64Url: 'key-b',
            serverUrl: 'https://server-b.example.test',
        });

        expect(getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'key-b',
            serverUrl: 'https://server-b.example.test',
        });

        await activateServerAccount('https://server-a.example.test', 'account-a');
        expect(getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'key-a',
            serverUrl: 'https://server-a.example.test',
        });
    });

    it('keeps pending payloads isolated by active account on the same server', async () => {
        const { setPendingTerminalConnect, getPendingTerminalConnect, clearPendingTerminalConnect } = await importFresh();

        await activateServerAccount('https://shared.example.test', 'account-a');
        clearPendingTerminalConnect();
        setPendingTerminalConnect({
            publicKeyB64Url: 'key-a',
            serverUrl: 'https://shared.example.test',
        });

        await activateServerAccount('https://shared.example.test', 'account-b');
        clearPendingTerminalConnect();
        expect(getPendingTerminalConnect()).toBeNull();
        setPendingTerminalConnect({
            publicKeyB64Url: 'key-b',
            serverUrl: 'https://shared.example.test',
        });

        expect(getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'key-b',
            serverUrl: 'https://shared.example.test',
        });

        await activateServerAccount('https://shared.example.test', 'account-a');
        expect(getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'key-a',
            serverUrl: 'https://shared.example.test',
        });
    });

    it('absorbs a host-derived scoped terminal connect into an identity scope', async () => {
        const now = 1_700_000_000_000;
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const {
            getPendingTerminalConnect,
            migratePendingTerminalConnectScopes,
            setPendingTerminalConnect,
        } = await importFresh();
        const { createServerAccountScope } = await import('@/sync/domains/scope/serverAccountScope');
        const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
        const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');

        await activateServerAccount('https://identity-terminal.example.test', 'account-a');
        setPendingTerminalConnect({
            publicKeyB64Url: 'key-identity',
            serverUrl: 'https://identity-terminal.example.test',
        });

        setServerProfileIdentityForUrl('https://identity-terminal.example.test', 'srv_identity_terminal');
        const legacyScope = createServerAccountScope('identity-terminal.example.test', 'account-a');
        const identityScope = createServerAccountScope('srv_identity_terminal', 'account-a');
        expect(legacyScope).not.toBeNull();
        expect(identityScope).not.toBeNull();
        registerStorageStateReader(() => ({ profileScope: identityScope } as unknown as StorageState));

        vi.spyOn(Date, 'now').mockReturnValue(now + 9 * 60 * 1000);
        migratePendingTerminalConnectScopes(identityScope!, [legacyScope!]);

        expect(getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'key-identity',
            serverUrl: 'https://identity-terminal.example.test',
        });
        registerStorageStateReader(() => ({ profileScope: legacyScope } as unknown as StorageState));
        expect(getPendingTerminalConnect()).toBeNull();
        registerStorageStateReader(() => ({ profileScope: identityScope } as unknown as StorageState));
        vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60 * 1000);
        expect(getPendingTerminalConnect()).toBeNull();
    });

    it('captures before auth, promotes only on the intended server, and keeps the promoted intent account-scoped', async () => {
        const owner = await importFresh();

        owner.setPendingTerminalConnect({
            publicKeyB64Url: 'native-preauth-key',
            serverUrl: 'https://native-a.example.test',
        });
        await activateServerWithoutAccount('https://native-a.example.test');
        expect(owner.getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'native-preauth-key',
            serverUrl: 'https://native-a.example.test',
        });

        await activateServerAccount('https://native-b.example.test', 'account-a');
        expect(owner.getPendingTerminalConnect()).toBeNull();

        await activateServerAccount('https://native-a.example.test', 'account-a');
        expect(owner.getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'native-preauth-key',
            serverUrl: 'https://native-a.example.test',
        });

        await activateServerAccount('https://native-a.example.test', 'account-b');
        expect(owner.getPendingTerminalConnect()).toBeNull();
    });

    it('preserves the pre-auth capture deadline when promoting and clears cancellation', async () => {
        const now = 1_700_000_000_000;
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const owner = await importFresh();

        owner.setPendingTerminalConnect({
            publicKeyB64Url: 'deadline-key',
            serverUrl: 'https://deadline.example.test',
        });
        vi.spyOn(Date, 'now').mockReturnValue(now + 9 * 60 * 1000);
        await activateServerAccount('https://deadline.example.test', 'account-a');
        expect(owner.getPendingTerminalConnect()).not.toBeNull();
        vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60 * 1000);
        expect(owner.getPendingTerminalConnect()).toBeNull();

        vi.spyOn(Date, 'now').mockReturnValue(now + 12 * 60 * 1000);
        owner.setPendingTerminalConnect({
            publicKeyB64Url: 'cancel-key',
            serverUrl: 'https://deadline.example.test',
        });
        owner.clearPendingTerminalConnect();
        expect(owner.getPendingTerminalConnect()).toBeNull();
    });

    it('retargets only unclaimed state and preserves its original deadline', async () => {
        const now = 1_700_000_000_000;
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const owner = await importFresh();
        owner.setPendingTerminalConnect({
            publicKeyB64Url: 'retarget-key',
            serverUrl: 'https://retarget-a.example.test',
        });
        vi.spyOn(Date, 'now').mockReturnValue(now + 5 * 60 * 1000);
        owner.retargetPendingTerminalConnectToServerUrl('https://retarget-b.example.test');
        vi.spyOn(Date, 'now').mockReturnValue(now + 9 * 60 * 1000);
        await activateServerAccount('https://retarget-b.example.test', 'account-a');
        expect(owner.getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'retarget-key',
            serverUrl: 'https://retarget-b.example.test',
        });
        vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60 * 1000);
        expect(owner.getPendingTerminalConnect()).toBeNull();
    });

    it('does not throw when native storage reads are unavailable', async () => {
        const owner = await importFresh();
        await activateServerAccount('https://native-storage-error.example.test', 'account-a');
        const { MMKV } = await import('react-native-mmkv');
        const originalGetString = MMKV.prototype.getString;
        const readSpy = vi.spyOn(MMKV.prototype, 'getString').mockImplementation(function (this: InstanceType<typeof MMKV>, key) {
            if (key === 'record:pre-auth:v1' || key.startsWith('record:v2:')) throw new Error('blocked');
            return originalGetString.call(this, key);
        });
        try {
            expect(() => owner.setPendingTerminalConnect({
                publicKeyB64Url: 'native-storage-error-key',
                serverUrl: 'https://native-storage-error.example.test',
            })).not.toThrow();
            expect(() => owner.getPendingTerminalConnect()).not.toThrow();
        } finally {
            readSpy.mockRestore();
        }
    });
});
