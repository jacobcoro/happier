import { MMKV } from 'react-native-mmkv';
import { serverAccountScopedStorageKey } from '@/sync/domains/scope/serverAccountScope';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import { createPendingTerminalConnectOwner } from './pendingTerminalConnectOwner';

const scope = readStorageScopeFromEnv();
const storage = new MMKV({ id: scopedStorageId('pending-terminal-connect', scope) });
const KEY_RECORD = 'record';
const KEY_RECORD_PREFIX = 'record:v2';
const KEY_PRE_AUTH_RECORD = 'record:pre-auth:v1';
const CLEARED_RECORD = '{"state":"cleared"}';

function readStoredItem(key: string): string | null {
    try {
        return storage.getString(key) ?? null;
    } catch {
        return null;
    }
}

function writeStoredItem(key: string, raw: string): boolean {
    try {
        storage.set(key, raw);
        return true;
    } catch {
        return false;
    }
}

function clearStoredItem(key: string): void {
    try {
        storage.set(key, CLEARED_RECORD);
    } catch {
        // If overwrite is unavailable, deletion below remains the best effort cleanup.
    }
    try {
        storage.delete(key);
    } catch {
        // A successful invalid overwrite still prevents a cleared request from resurfacing.
    }
}

const owner = createPendingTerminalConnectOwner({
    readPreAuth: () => readStoredItem(KEY_PRE_AUTH_RECORD),
    writePreAuth: (raw) => writeStoredItem(KEY_PRE_AUTH_RECORD, raw),
    clearPreAuth: () => clearStoredItem(KEY_PRE_AUTH_RECORD),
    readScoped: (accountScope) => readStoredItem(serverAccountScopedStorageKey(KEY_RECORD_PREFIX, accountScope)),
    writeScoped: (accountScope, raw) => writeStoredItem(
        serverAccountScopedStorageKey(KEY_RECORD_PREFIX, accountScope),
        raw,
    ),
    clearScoped: (accountScope) => clearStoredItem(serverAccountScopedStorageKey(KEY_RECORD_PREFIX, accountScope)),
    readLegacy: () => readStoredItem(KEY_RECORD),
    clearLegacy: () => clearStoredItem(KEY_RECORD),
});

export const setPendingTerminalConnect = owner.setPendingTerminalConnect;
export const getPendingTerminalConnect = owner.getPendingTerminalConnect;
export const retargetPendingTerminalConnectToServerUrl = owner.retargetPendingTerminalConnectToServerUrl;
export const clearPendingTerminalConnect = owner.clearPendingTerminalConnect;
export const migratePendingTerminalConnectScopes = owner.migratePendingTerminalConnectScopes;
