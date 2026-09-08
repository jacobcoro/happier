import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import {
    areServerAccountScopesEqual,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import {
    fromRecord,
    parsePreAuthRecord,
    parseRecord,
    recordsRepresentSameRequest,
    toRecord,
    type PendingTerminalConnect,
    type PendingTerminalConnectRecord,
    type PreAuthPendingTerminalConnectRecord,
} from './pendingTerminalConnect.shared';
import { isPendingServerUrlActive, normalizePendingServerUrl } from './pendingServerScopedKeys';

export type PendingTerminalConnectStorageAdapter = Readonly<{
    readPreAuth: () => string | null;
    writePreAuth: (raw: string) => boolean;
    clearPreAuth: () => void;
    readScoped: (scope: ServerAccountScope) => string | null;
    writeScoped: (scope: ServerAccountScope, raw: string) => boolean;
    clearScoped: (scope: ServerAccountScope) => void;
    readLegacy: () => string | null;
    clearLegacy: () => void;
}>;

export function createPendingTerminalConnectOwner(adapter: PendingTerminalConnectStorageAdapter) {
    let memoryPreAuthRecord: PreAuthPendingTerminalConnectRecord | null | undefined;

    function readPreAuthRecord(): PreAuthPendingTerminalConnectRecord | null {
        if (memoryPreAuthRecord !== undefined) {
            if (memoryPreAuthRecord && fromRecord(memoryPreAuthRecord.record)) return memoryPreAuthRecord;
            memoryPreAuthRecord = null;
            return null;
        }
        const raw = adapter.readPreAuth();
        if (!raw) {
            memoryPreAuthRecord = null;
            return null;
        }
        try {
            const envelope = parsePreAuthRecord(JSON.parse(raw) as unknown);
            if (!envelope) {
                adapter.clearPreAuth();
                memoryPreAuthRecord = null;
                return null;
            }
            memoryPreAuthRecord = envelope;
            return envelope;
        } catch {
            adapter.clearPreAuth();
            memoryPreAuthRecord = null;
            return null;
        }
    }

    function persistPreAuthRecord(envelope: PreAuthPendingTerminalConnectRecord): void {
        memoryPreAuthRecord = envelope;
        if (!adapter.writePreAuth(JSON.stringify(envelope))) {
            // Keep the newest request in memory, but prevent an older durable envelope resurfacing.
            adapter.clearPreAuth();
        }
    }

    function clearPreAuthRecord(): void {
        memoryPreAuthRecord = null;
        adapter.clearPreAuth();
    }

    function readScopedRawRecord(scope: ServerAccountScope): PendingTerminalConnectRecord | null {
        const raw = adapter.readScoped(scope);
        if (!raw) return null;
        try {
            const record = parseRecord(JSON.parse(raw) as unknown);
            if (!record) adapter.clearScoped(scope);
            return record;
        } catch {
            adapter.clearScoped(scope);
            return null;
        }
    }

    function setPendingTerminalConnect(value: PendingTerminalConnect): void {
        const activeScope = getActiveServerAccountScope();
        const serverUrl = normalizePendingServerUrl(value.serverUrl);
        if (!serverUrl) return;
        const candidate = toRecord({ ...value, serverUrl });
        if (!candidate) return;
        const preAuth = readPreAuthRecord();
        const scopedRecord = activeScope ? readScopedRawRecord(activeScope) : null;
        const previous = [preAuth?.record, scopedRecord]
            .find((record): record is PendingTerminalConnectRecord => Boolean(record && recordsRepresentSameRequest(record, candidate)));
        const record = previous ? { ...candidate, createdAtMs: previous.createdAtMs } : candidate;

        if (activeScope && isPendingServerUrlActive(serverUrl)) {
            const claimed = { state: 'pre_auth', record, claimedScope: activeScope } satisfies PreAuthPendingTerminalConnectRecord;
            // Bind to the claiming account before storage so a failed scoped write cannot expose it later.
            persistPreAuthRecord(claimed);
            if (adapter.writeScoped(activeScope, JSON.stringify(record))) clearPreAuthRecord();
            return;
        }

        persistPreAuthRecord({ state: 'pre_auth', record });
    }

    function getPendingTerminalConnect(): PendingTerminalConnect | null {
        const activeScope = getActiveServerAccountScope();
        const preAuth = readPreAuthRecord();
        if (preAuth && isPendingServerUrlActive(preAuth.record.serverUrl)) {
            if (!activeScope) return preAuth.claimedScope ? null : fromRecord(preAuth.record);
            if (!preAuth.claimedScope || areServerAccountScopesEqual(preAuth.claimedScope, activeScope)) {
                const scopedRecord = readScopedRawRecord(activeScope);
                if (scopedRecord && scopedRecord.createdAtMs > preAuth.record.createdAtMs) {
                    clearPreAuthRecord();
                    return fromRecord(scopedRecord);
                }
                const claimed = { ...preAuth, claimedScope: activeScope } satisfies PreAuthPendingTerminalConnectRecord;
                persistPreAuthRecord(claimed);
                if (adapter.writeScoped(activeScope, JSON.stringify(claimed.record))) clearPreAuthRecord();
                return fromRecord(claimed.record);
            }
        }
        if (!activeScope) return null;
        return fromRecord(readScopedRawRecord(activeScope));
    }

    function retargetPendingTerminalConnectToServerUrl(serverUrl: string): void {
        const targetServerUrl = normalizePendingServerUrl(serverUrl);
        if (!targetServerUrl) return;
        const preAuth = readPreAuthRecord();
        if (!preAuth || preAuth.claimedScope) return;
        if (normalizePendingServerUrl(preAuth.record.serverUrl) === targetServerUrl) return;
        persistPreAuthRecord({
            state: 'pre_auth',
            record: { ...preAuth.record, serverUrl: targetServerUrl },
        });
    }

    function clearPendingTerminalConnect(): void {
        clearPreAuthRecord();
        const activeScope = getActiveServerAccountScope();
        if (activeScope) adapter.clearScoped(activeScope);
        const raw = adapter.readLegacy();
        if (!raw) return;
        try {
            const record = fromRecord(JSON.parse(raw) as unknown);
            if (!record || isPendingServerUrlActive(record.serverUrl)) adapter.clearLegacy();
        } catch {
            adapter.clearLegacy();
        }
    }

    function migratePendingTerminalConnectScopes(
        scope: ServerAccountScope,
        legacyScopes: readonly ServerAccountScope[],
    ): void {
        let hasCanonicalRecord = readScopedRawRecord(scope) !== null;
        for (const legacyScope of legacyScopes) {
            if (areServerAccountScopesEqual(legacyScope, scope)) continue;
            const legacyRecord = readScopedRawRecord(legacyScope);
            if (hasCanonicalRecord) {
                adapter.clearScoped(legacyScope);
                continue;
            }
            if (legacyRecord && adapter.writeScoped(scope, JSON.stringify(legacyRecord))) {
                hasCanonicalRecord = true;
                adapter.clearScoped(legacyScope);
            }
        }
    }

    return {
        setPendingTerminalConnect,
        getPendingTerminalConnect,
        retargetPendingTerminalConnectToServerUrl,
        clearPendingTerminalConnect,
        migratePendingTerminalConnectScopes,
    };
}
