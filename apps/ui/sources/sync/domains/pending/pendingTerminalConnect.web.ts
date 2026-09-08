import { serverAccountScopedStorageKey } from '@/sync/domains/scope/serverAccountScope';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import { createPendingTerminalConnectOwner } from './pendingTerminalConnectOwner';

const STORAGE_KEY = scopedStorageId('pending-terminal-connect-record', readStorageScopeFromEnv());
const STORAGE_KEY_PREFIX = scopedStorageId('pending-terminal-connect-record:v2', readStorageScopeFromEnv());
const PRE_AUTH_STORAGE_KEY = scopedStorageId('pending-terminal-connect-record:pre-auth:v1', readStorageScopeFromEnv());
const CLEARED_RECORD = '{"state":"cleared"}';

function getStorage(): Storage | null {
    try {
        return (globalThis as { localStorage?: Storage }).localStorage ?? null;
    } catch {
        return null;
    }
}

function getPreAuthStorage(): Storage | null {
    try {
        return (globalThis as { sessionStorage?: Storage }).sessionStorage ?? null;
    } catch {
        return null;
    }
}

function readStorageItem(storage: Storage | null, key: string): string | null {
    try {
        return storage?.getItem(key) ?? null;
    } catch {
        return null;
    }
}

function writeStorageItem(storage: Storage | null, key: string, raw: string): boolean {
    try {
        if (!storage) return false;
        storage.setItem(key, raw);
        return true;
    } catch {
        return false;
    }
}

function clearStorageItem(storage: Storage | null, key: string): void {
    try {
        storage?.setItem(key, CLEARED_RECORD);
    } catch {
        // If overwrite is unavailable, deletion below remains the best effort cleanup.
    }
    try {
        storage?.removeItem(key);
    } catch {
        // A successful invalid overwrite still prevents a cleared request from resurfacing.
    }
}

const owner = createPendingTerminalConnectOwner({
    readPreAuth: () => readStorageItem(getPreAuthStorage(), PRE_AUTH_STORAGE_KEY),
    writePreAuth: (raw) => writeStorageItem(getPreAuthStorage(), PRE_AUTH_STORAGE_KEY, raw),
    clearPreAuth: () => clearStorageItem(getPreAuthStorage(), PRE_AUTH_STORAGE_KEY),
    readScoped: (scope) => readStorageItem(
        getStorage(),
        serverAccountScopedStorageKey(STORAGE_KEY_PREFIX, scope),
    ),
    writeScoped: (scope, raw) => writeStorageItem(
        getStorage(),
        serverAccountScopedStorageKey(STORAGE_KEY_PREFIX, scope),
        raw,
    ),
    clearScoped: (scope) => clearStorageItem(
        getStorage(),
        serverAccountScopedStorageKey(STORAGE_KEY_PREFIX, scope),
    ),
    readLegacy: () => readStorageItem(getStorage(), STORAGE_KEY),
    clearLegacy: () => clearStorageItem(getStorage(), STORAGE_KEY),
});

export const setPendingTerminalConnect = owner.setPendingTerminalConnect;
export const getPendingTerminalConnect = owner.getPendingTerminalConnect;
export const retargetPendingTerminalConnectToServerUrl = owner.retargetPendingTerminalConnectToServerUrl;
export const clearPendingTerminalConnect = owner.clearPendingTerminalConnect;
export const migratePendingTerminalConnectScopes = owner.migratePendingTerminalConnectScopes;
