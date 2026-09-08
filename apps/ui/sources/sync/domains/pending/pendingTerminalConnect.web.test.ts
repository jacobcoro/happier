import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageState } from '@/sync/store/types';

type StorageLike = {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
};

function createLocalStorage(): StorageLike {
    const map = new Map<string, string>();
    return {
        getItem: (key) => (map.has(key) ? map.get(key)! : null),
        setItem: (key, value) => {
            map.set(key, value);
        },
        removeItem: (key) => {
            map.delete(key);
        },
    };
}

async function importFreshWeb() {
    vi.resetModules();
    return await import('./pendingTerminalConnect.web');
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

describe('pendingTerminalConnect.web', () => {
    beforeEach(() => {
        vi.stubGlobal('localStorage', createLocalStorage());
        vi.stubGlobal('sessionStorage', createLocalStorage());
    });

    afterEach(async () => {
        const { clearPendingTerminalConnect } = await importFreshWeb();
        clearPendingTerminalConnect();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('round-trips a pending terminal connect payload on web', async () => {
        const now = 1_700_000_000_000;
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const { setPendingTerminalConnect, getPendingTerminalConnect } = await importFreshWeb();

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

    it('expires stale pending payloads on web', async () => {
        const now = 1_700_000_000_000;
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const { setPendingTerminalConnect, getPendingTerminalConnect } = await importFreshWeb();

        await activateServerAccount('https://stack.example.test', 'account-a');
        setPendingTerminalConnect({
            publicKeyB64Url: 'abcDEF_123-zzz',
            serverUrl: 'https://stack.example.test',
        });

        vi.spyOn(Date, 'now').mockReturnValue(now + 60 * 60 * 1000);
        expect(getPendingTerminalConnect()).toBeNull();
    });

    it('rejects a pending payload after its pairing deadline', async () => {
        const now = 1_700_000_000_000;
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const { setPendingTerminalConnect, getPendingTerminalConnect } = await importFreshWeb();
        await activateServerAccount('https://stack.example.test', 'account-a');
        setPendingTerminalConnect({
            publicKeyB64Url: 'pairing-key',
            serverUrl: 'https://stack.example.test',
            pairing: { secretB64Url: 'synthetic-secret', createdAtMs: now, expiresAtMs: now + 1_000 },
        });
        vi.spyOn(Date, 'now').mockReturnValue(now + 1_000);
        expect(getPendingTerminalConnect()).toBeNull();
    });

    it('keeps terminal connect payloads isolated by active account on web', async () => {
        const { setPendingTerminalConnect, getPendingTerminalConnect, clearPendingTerminalConnect } = await importFreshWeb();

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

    it('captures an unauthenticated intent in the current tab and promotes it after account hydration', async () => {
        const now = 1_700_000_000_000;
        vi.spyOn(Date, 'now').mockReturnValue(now);
        let owner = await importFreshWeb();

        owner.setPendingTerminalConnect({
            publicKeyB64Url: 'preauth-key',
            serverUrl: 'https://signup.example.test/',
        });
        await activateServerWithoutAccount('https://signup.example.test');
        expect(owner.getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'preauth-key',
            serverUrl: 'https://signup.example.test',
        });

        owner = await importFreshWeb();
        expect(owner.getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'preauth-key',
            serverUrl: 'https://signup.example.test',
        });

        await activateServerAccount('https://signup.example.test', 'account-a');
        expect(owner.getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'preauth-key',
            serverUrl: 'https://signup.example.test',
        });

        await activateServerAccount('https://signup.example.test', 'account-b');
        expect(owner.getPendingTerminalConnect()).toBeNull();
        await activateServerAccount('https://signup.example.test', 'account-a');
        expect(owner.getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'preauth-key',
            serverUrl: 'https://signup.example.test',
        });
    });

    it('does not promote a pre-auth intent on a different server and preserves its original deadline', async () => {
        const now = 1_700_000_000_000;
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const owner = await importFreshWeb();

        owner.setPendingTerminalConnect({
            publicKeyB64Url: 'server-a-key',
            serverUrl: 'https://server-a.example.test',
        });

        await activateServerAccount('https://server-b.example.test', 'account-a');
        expect(owner.getPendingTerminalConnect()).toBeNull();

        vi.spyOn(Date, 'now').mockReturnValue(now + 5 * 60 * 1000);
        owner.retargetPendingTerminalConnectToServerUrl('https://server-c.example.test');

        vi.spyOn(Date, 'now').mockReturnValue(now + 9 * 60 * 1000);
        await activateServerAccount('https://server-c.example.test', 'account-a');
        expect(owner.getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'server-a-key',
            serverUrl: 'https://server-c.example.test',
        });

        vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60 * 1000);
        expect(owner.getPendingTerminalConnect()).toBeNull();
    });

    it('lets the newest explicit pre-auth link replace an older pending link for the claiming account', async () => {
        const now = 1_700_000_000_000;
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const owner = await importFreshWeb();

        await activateServerAccount('https://newest.example.test', 'account-a');
        owner.setPendingTerminalConnect({
            publicKeyB64Url: 'older-key',
            serverUrl: 'https://newest.example.test',
        });
        await activateServerWithoutAccount('https://newest.example.test');
        vi.spyOn(Date, 'now').mockReturnValue(now + 1_000);
        owner.setPendingTerminalConnect({
            publicKeyB64Url: 'newer-key',
            serverUrl: 'https://newest.example.test',
        });

        await activateServerAccount('https://newest.example.test', 'account-a');
        expect(owner.getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'newer-key',
            serverUrl: 'https://newest.example.test',
        });
    });

    it('binds a failed promotion to its first eligible account', async () => {
        const owner = await importFreshWeb();
        owner.setPendingTerminalConnect({
            publicKeyB64Url: 'claimed-key',
            serverUrl: 'https://claimed.example.test',
        });
        vi.stubGlobal('localStorage', {
            getItem: () => null,
            setItem: () => { throw new Error('quota'); },
            removeItem: () => {},
        } satisfies StorageLike);

        await activateServerAccount('https://claimed.example.test', 'account-a');
        expect(owner.getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'claimed-key',
            serverUrl: 'https://claimed.example.test',
        });
        await activateServerAccount('https://claimed.example.test', 'account-b');
        expect(owner.getPendingTerminalConnect()).toBeNull();
    });

    it('does not expose a pre-auth intent to another browser tab', async () => {
        const tabAStorage = createLocalStorage();
        const tabBStorage = createLocalStorage();
        vi.stubGlobal('sessionStorage', tabAStorage);
        let owner = await importFreshWeb();
        owner.setPendingTerminalConnect({
            publicKeyB64Url: 'tab-a-key',
            serverUrl: 'https://tabs.example.test',
        });
        await activateServerWithoutAccount('https://tabs.example.test');
        expect(owner.getPendingTerminalConnect()).not.toBeNull();

        vi.stubGlobal('sessionStorage', tabBStorage);
        owner = await importFreshWeb();
        expect(owner.getPendingTerminalConnect()).toBeNull();

        vi.stubGlobal('sessionStorage', tabAStorage);
        owner = await importFreshWeb();
        expect(owner.getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'tab-a-key',
            serverUrl: 'https://tabs.example.test',
        });
    });

    it('clears a cancelled pre-auth intent and retains it in memory when session storage rejects the write', async () => {
        const owner = await importFreshWeb();
        const failingStorage: StorageLike = {
            getItem: () => null,
            setItem: () => { throw new Error('quota'); },
            removeItem: () => {},
        };
        vi.stubGlobal('sessionStorage', failingStorage);

        owner.setPendingTerminalConnect({
            publicKeyB64Url: 'memory-key',
            serverUrl: 'https://memory.example.test',
        });
        await activateServerWithoutAccount('https://memory.example.test');
        expect(owner.getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'memory-key',
            serverUrl: 'https://memory.example.test',
        });

        owner.clearPendingTerminalConnect();
        expect(owner.getPendingTerminalConnect()).toBeNull();
    });

    it('does not resurrect an older pre-auth intent after a newer capture cannot be persisted', async () => {
        let persisted: string | null = null;
        let rejectWrites = false;
        vi.stubGlobal('sessionStorage', {
            getItem: () => persisted,
            setItem: (_key, value) => {
                if (rejectWrites) throw new Error('quota');
                persisted = value;
            },
            removeItem: () => { persisted = null; },
        } satisfies StorageLike);
        let owner = await importFreshWeb();
        owner.setPendingTerminalConnect({
            publicKeyB64Url: 'older-persisted-key',
            serverUrl: 'https://write-failure.example.test',
        });
        rejectWrites = true;
        owner.setPendingTerminalConnect({
            publicKeyB64Url: 'newer-memory-key',
            serverUrl: 'https://write-failure.example.test',
        });
        await activateServerWithoutAccount('https://write-failure.example.test');
        expect(owner.getPendingTerminalConnect()?.publicKeyB64Url).toBe('newer-memory-key');

        owner = await importFreshWeb();
        expect(owner.getPendingTerminalConnect()).toBeNull();
    });

    it('does not resurrect a cancelled pre-auth intent when session storage rejects deletion', async () => {
        let persisted: string | null = null;
        vi.stubGlobal('sessionStorage', {
            getItem: () => persisted,
            setItem: (_key, value) => { persisted = value; },
            removeItem: () => { throw new Error('blocked'); },
        } satisfies StorageLike);
        let owner = await importFreshWeb();
        owner.setPendingTerminalConnect({
            publicKeyB64Url: 'cancelled-key',
            serverUrl: 'https://cancelled.example.test',
        });
        await activateServerWithoutAccount('https://cancelled.example.test');
        expect(owner.getPendingTerminalConnect()).not.toBeNull();

        owner.clearPendingTerminalConnect();
        expect(persisted).not.toBeNull();
        owner = await importFreshWeb();
        expect(owner.getPendingTerminalConnect()).toBeNull();
    });

    it('does not resurrect a cleared account-scoped intent when local storage rejects deletion', async () => {
        const persisted = new Map<string, string>();
        vi.stubGlobal('localStorage', {
            getItem: (key) => persisted.get(key) ?? null,
            setItem: (key, value) => { persisted.set(key, value); },
            removeItem: () => { throw new Error('blocked'); },
        } satisfies StorageLike);
        let owner = await importFreshWeb();
        await activateServerAccount('https://scoped-clear.example.test', 'account-a');
        owner.setPendingTerminalConnect({
            publicKeyB64Url: 'scoped-clear-key',
            serverUrl: 'https://scoped-clear.example.test',
        });
        expect(owner.getPendingTerminalConnect()).not.toBeNull();

        owner.clearPendingTerminalConnect();
        owner = await importFreshWeb();
        await activateServerAccount('https://scoped-clear.example.test', 'account-a');
        expect(owner.getPendingTerminalConnect()).toBeNull();
    });

    it('survives a throwing localStorage accessor while retaining and cancelling pre-auth state', async () => {
        const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
        Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            get: () => { throw new Error('blocked'); },
        });
        try {
            const owner = await importFreshWeb();
            expect(() => owner.setPendingTerminalConnect({
                publicKeyB64Url: 'security-error-key',
                serverUrl: 'https://security-error.example.test',
            })).not.toThrow();
            await activateServerWithoutAccount('https://security-error.example.test');
            expect(owner.getPendingTerminalConnect()).toEqual({
                publicKeyB64Url: 'security-error-key',
                serverUrl: 'https://security-error.example.test',
            });
            expect(() => owner.clearPendingTerminalConnect()).not.toThrow();
            expect(owner.getPendingTerminalConnect()).toBeNull();
        } finally {
            if (originalDescriptor) {
                Object.defineProperty(globalThis, 'localStorage', originalDescriptor);
            } else {
                Reflect.deleteProperty(globalThis, 'localStorage');
            }
        }
    });

    it('binds an active account intent even when localStorage is unavailable', async () => {
        const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
        Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            get: () => { throw new Error('blocked'); },
        });
        try {
            const owner = await importFreshWeb();
            await activateServerAccount('https://claimed-storage-error.example.test', 'account-a');
            owner.setPendingTerminalConnect({
                publicKeyB64Url: 'claimed-storage-error-key',
                serverUrl: 'https://claimed-storage-error.example.test',
            });

            await activateServerAccount('https://claimed-storage-error.example.test', 'account-b');
            expect(owner.getPendingTerminalConnect()).toBeNull();
            await activateServerAccount('https://claimed-storage-error.example.test', 'account-a');
            expect(owner.getPendingTerminalConnect()).toEqual({
                publicKeyB64Url: 'claimed-storage-error-key',
                serverUrl: 'https://claimed-storage-error.example.test',
            });
        } finally {
            if (originalDescriptor) {
                Object.defineProperty(globalThis, 'localStorage', originalDescriptor);
            } else {
                Reflect.deleteProperty(globalThis, 'localStorage');
            }
        }
    });

    it('keeps a newer account-scoped request when an older tab-local pre-auth request is resumed', async () => {
        const now = 1_700_000_000_000;
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const tabAStorage = createLocalStorage();
        const tabBStorage = createLocalStorage();
        vi.stubGlobal('sessionStorage', tabAStorage);
        let owner = await importFreshWeb();
        owner.setPendingTerminalConnect({
            publicKeyB64Url: 'older-tab-key',
            serverUrl: 'https://precedence.example.test',
        });

        vi.spyOn(Date, 'now').mockReturnValue(now + 1_000);
        vi.stubGlobal('sessionStorage', tabBStorage);
        owner = await importFreshWeb();
        await activateServerAccount('https://precedence.example.test', 'account-a');
        owner.setPendingTerminalConnect({
            publicKeyB64Url: 'newer-scoped-key',
            serverUrl: 'https://precedence.example.test',
        });

        vi.stubGlobal('sessionStorage', tabAStorage);
        owner = await importFreshWeb();
        await activateServerAccount('https://precedence.example.test', 'account-a');
        expect(owner.getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'newer-scoped-key',
            serverUrl: 'https://precedence.example.test',
        });
    });

    it('retains a valid legacy scoped request when canonical scope migration cannot write', async () => {
        const persisted = new Map<string, string>();
        let rejectWrites = false;
        vi.stubGlobal('localStorage', {
            getItem: (key) => persisted.get(key) ?? null,
            setItem: (key, value) => {
                if (rejectWrites) throw new Error('quota');
                persisted.set(key, value);
            },
            removeItem: (key) => { persisted.delete(key); },
        } satisfies StorageLike);
        const owner = await importFreshWeb();
        await activateServerAccount('https://migration-failure.example.test', 'account-a');
        const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { createServerAccountScope } = await import('@/sync/domains/scope/serverAccountScope');
        const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
        const legacyScope = getActiveServerAccountScope();
        const canonicalScope = createServerAccountScope('srv_migration_failure', 'account-a');
        expect(legacyScope).not.toBeNull();
        expect(canonicalScope).not.toBeNull();
        owner.setPendingTerminalConnect({
            publicKeyB64Url: 'migration-failure-key',
            serverUrl: 'https://migration-failure.example.test',
        });

        rejectWrites = true;
        owner.migratePendingTerminalConnectScopes(canonicalScope!, [legacyScope!]);
        rejectWrites = false;
        registerStorageStateReader(() => ({ profileScope: legacyScope } as unknown as StorageState));
        expect(owner.getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'migration-failure-key',
            serverUrl: 'https://migration-failure.example.test',
        });
    });

    it('keeps an account-scoped request with its claiming account when a different server is selected', async () => {
        const owner = await importFreshWeb();
        await activateServerAccount('https://claimed-a.example.test', 'account-a');
        owner.setPendingTerminalConnect({
            publicKeyB64Url: 'account-a-key',
            serverUrl: 'https://claimed-a.example.test',
        });

        owner.retargetPendingTerminalConnectToServerUrl('https://claimed-b.example.test');
        await activateServerAccount('https://claimed-b.example.test', 'account-b');
        expect(owner.getPendingTerminalConnect()).toBeNull();
        await activateServerAccount('https://claimed-a.example.test', 'account-a');
        expect(owner.getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'account-a-key',
            serverUrl: 'https://claimed-a.example.test',
        });
    });
});
