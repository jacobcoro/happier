import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readPendingLocalId } from '@happier-dev/protocol';
import { Platform } from 'react-native';

import { getPersistenceStorage } from './persistence';
import { scopedSessionLocalStateKey } from './sessionLocalStateKeys';
import { updateBrowserRecord } from './browserRecordStorage';

export type PersistedPendingEnqueueRequestV1 = Readonly<{
    v: 1;
    body: string;
}>;

export type PendingOutboxQuarantineReason =
    | 'unsupported_persisted_operation'
    | 'invalid_persisted_local_id'
    | 'invalid_persisted_envelope';

export type PersistedPendingOutboxMessage = Readonly<{
    sessionId: string;
    localId: string;
    createdAt: number;
    text: string;
    displayText?: string;
    rawRecord: unknown;
    operation: 'enqueue' | 'cancel' | 'quarantined';
    pendingOutboxQuarantineReason?: PendingOutboxQuarantineReason;
    request: PersistedPendingEnqueueRequestV1;
}>;

function pendingOutboxKey(scope: ServerAccountScope): string {
    return scopedSessionLocalStateKey('session-pending-outbox-v1', scope);
}

export function assertSafePendingIdPathSegment(pendingId: string): void {
    if (pendingId === '.' || pendingId === '..') {
        throw new Error('Pending message ID cannot be a dot path segment');
    }
}

function isValidPendingEnqueueBody(body: string, localId: string): boolean {
    try {
        const parsed = JSON.parse(body) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
        const record = parsed as Record<string, unknown>;
        if (record.localId !== localId || record.messageRole !== 'user') return false;
        const hasCiphertextField = Object.prototype.hasOwnProperty.call(record, 'ciphertext');
        const hasContentField = Object.prototype.hasOwnProperty.call(record, 'content');
        const hasCiphertext = typeof record.ciphertext === 'string' && record.ciphertext.length > 0;
        const content = record.content;
        const contentRecord = content && typeof content === 'object' && !Array.isArray(content)
            ? content as Record<string, unknown>
            : null;
        const hasPlainContent = contentRecord?.t === 'plain'
            && Object.prototype.hasOwnProperty.call(contentRecord, 'v');
        // The local outbox freezes the current UI writer shape. Server readers may accept broader
        // stored-content compatibility envelopes, but those are not alternate local request formats.
        return (hasCiphertext && !hasContentField)
            || (hasPlainContent && !hasCiphertextField);
    } catch {
        return false;
    }
}

function parseRow(sessionId: string, value: unknown): PersistedPendingOutboxMessage | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const input = value as Record<string, unknown>;
    const localId = readPendingLocalId(input.localId) ?? '';
    if (!localId) return null;
    const createdAt = typeof input.createdAt === 'number' && Number.isFinite(input.createdAt)
        ? input.createdAt
        : null;
    const requestInput = input.request;
    const request = requestInput && typeof requestInput === 'object' && !Array.isArray(requestInput)
        ? requestInput as Record<string, unknown>
        : null;
    const requestBody = typeof request?.body === 'string' ? request.body : '';
    const requestEnvelopeValid = request?.v === 1 && isValidPendingEnqueueBody(requestBody, localId);
    const persistedQuarantineReason: PendingOutboxQuarantineReason | undefined =
        input.pendingOutboxQuarantineReason === 'unsupported_persisted_operation'
        || input.pendingOutboxQuarantineReason === 'invalid_persisted_local_id'
        || input.pendingOutboxQuarantineReason === 'invalid_persisted_envelope'
            ? input.pendingOutboxQuarantineReason
            : undefined;
    let pendingOutboxQuarantineReason: PendingOutboxQuarantineReason | undefined;
    if (localId === '.' || localId === '..') {
        pendingOutboxQuarantineReason = 'invalid_persisted_local_id';
    } else if (!requestEnvelopeValid) {
        pendingOutboxQuarantineReason = 'invalid_persisted_envelope';
    } else if (input.operation === 'quarantined') {
        pendingOutboxQuarantineReason = persistedQuarantineReason ?? 'unsupported_persisted_operation';
    } else if (input.operation !== undefined && input.operation !== 'enqueue' && input.operation !== 'cancel') {
        pendingOutboxQuarantineReason = 'unsupported_persisted_operation';
    }
    return {
        sessionId,
        localId,
        createdAt: createdAt ?? 0,
        text: typeof input.text === 'string' ? input.text : '',
        ...(typeof input.displayText === 'string' ? { displayText: input.displayText } : {}),
        rawRecord: input.rawRecord,
        operation: pendingOutboxQuarantineReason
            ? 'quarantined'
            : input.operation === 'cancel' ? 'cancel' : 'enqueue',
        ...(pendingOutboxQuarantineReason ? { pendingOutboxQuarantineReason } : {}),
        request: { v: 1, body: requestBody },
    };
}

function parsePendingOutbox(raw: string | undefined, strict = false): Record<string, PersistedPendingOutboxMessage[]> {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid pending outbox');
        const result: Record<string, PersistedPendingOutboxMessage[]> = {};
        for (const [rawSessionId, rawRows] of Object.entries(parsed as Record<string, unknown>)) {
            const sessionId = rawSessionId.trim();
            if (!sessionId || !Array.isArray(rawRows)) {
                if (strict) throw new Error('Invalid pending outbox session');
                continue;
            }
            const rows = rawRows
                .map((row) => parseRow(sessionId, row))
                .filter((row): row is PersistedPendingOutboxMessage => row !== null);
            if (strict && rows.length !== rawRows.length) throw new Error('Invalid pending outbox row');
            if (rows.length > 0) result[sessionId] = rows;
        }
        return result;
    } catch (error) {
        if (strict) throw error;
        return {};
    }
}

function updatePendingOutbox<T>(scope: ServerAccountScope, update: (outbox: Record<string, PersistedPendingOutboxMessage[]>) => T): Promise<T> {
    const key = pendingOutboxKey(scope);
    const storage = getPersistenceStorage();
    if (Platform.OS !== 'web') {
        const outbox = parsePendingOutbox(storage.getString(key));
        const previous = JSON.stringify(outbox);
        const result = update(outbox);
        if (JSON.stringify(outbox) !== previous) writePendingOutbox(outbox, scope);
        return Promise.resolve(result);
    }
    const legacy = storage.getString(key);
    return updateBrowserRecord(key, (current) => {
        assertLegacyOutboxCompatible(current, legacy);
        const outbox = parsePendingOutbox(current ?? legacy, true);
        const result = update(outbox);
        return { value: JSON.stringify(outbox), result };
    }).then((result) => {
        if (legacy !== undefined && storage.getString(key) === legacy) storage.delete(key);
        return result;
    });
}

function assertLegacyOutboxCompatible(current: string | undefined, legacy: string | undefined): void {
    if (current !== undefined && legacy !== undefined && current !== legacy) {
        throw Object.assign(new Error('An older tab has different pending messages. Both copies were preserved; resolve those pending messages before retrying.'), {
            code: 'pending_outbox_storage_conflict',
        });
    }
}

export async function loadPendingOutbox(scope: ServerAccountScope): Promise<Record<string, PersistedPendingOutboxMessage[]>> {
    if (Platform.OS !== 'web') return parsePendingOutbox(getPersistenceStorage().getString(pendingOutboxKey(scope)));
    const key = pendingOutboxKey(scope);
    const storage = getPersistenceStorage();
    const legacy = storage.getString(key);
    const raw = await updateBrowserRecord(key, (current) => {
        assertLegacyOutboxCompatible(current, legacy);
        return { value: current ?? legacy, result: current ?? legacy };
    });
    if (legacy !== undefined && storage.getString(key) === legacy) storage.delete(key);
    return parsePendingOutbox(raw, true);
}

export async function listPendingOutboxSessionIds(scope: ServerAccountScope): Promise<string[]> {
    return Object.keys(await loadPendingOutbox(scope)).sort();
}

export async function loadPendingOutboxForSession(
    sessionId: string,
    scope: ServerAccountScope,
): Promise<PersistedPendingOutboxMessage[]> {
    return (await loadPendingOutbox(scope))[sessionId.trim()] ?? [];
}

export async function findPendingOutboxMessage(
    sessionId: string,
    localId: string,
    scope: ServerAccountScope,
): Promise<PersistedPendingOutboxMessage | null> {
    if (readPendingLocalId(localId) === null) return null;
    return (await loadPendingOutboxForSession(sessionId, scope))
        .find((row) => row.localId === localId) ?? null;
}

function writePendingOutbox(
    outbox: Record<string, PersistedPendingOutboxMessage[]>,
    scope: ServerAccountScope,
): void {
    const storage = getPersistenceStorage();
    const nonEmpty = Object.fromEntries(Object.entries(outbox).filter(([, rows]) => rows.length > 0));
    if (Object.keys(nonEmpty).length === 0) {
        storage.delete(pendingOutboxKey(scope));
        return;
    }
    storage.set(pendingOutboxKey(scope), JSON.stringify(nonEmpty));
}

export async function savePendingOutboxMessage(
    message: Omit<PersistedPendingOutboxMessage, 'operation' | 'pendingOutboxQuarantineReason'>
        & Readonly<{ operation?: 'enqueue' | 'cancel' }>,
    scope: ServerAccountScope,
): Promise<PersistedPendingOutboxMessage> {
    const sessionId = message.sessionId.trim();
    const localId = message.localId;
    if (!sessionId || readPendingLocalId(localId) === null) {
        throw new Error('Pending outbox sessionId and localId are required');
    }
    assertSafePendingIdPathSegment(localId);
    if (!isValidPendingEnqueueBody(message.request.body, localId)) {
        throw new Error('Pending outbox request envelope is invalid');
    }
    return updatePendingOutbox(scope, (outbox) => {
        const rows = outbox[sessionId] ?? [];
        const existing = rows.find((row) => row.localId === localId);
        if (existing) return existing;
        const next = {
            ...message,
            sessionId,
            localId,
            operation: message.operation ?? 'enqueue',
        };
        outbox[sessionId] = [...rows, next];
        return next;
    });
}

export async function markPendingOutboxMessageCancelRequested(
    sessionId: string,
    localId: string,
    scope: ServerAccountScope,
): Promise<PersistedPendingOutboxMessage | null> {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId || readPendingLocalId(localId) === null) return null;
    return updatePendingOutbox(scope, (outbox) => {
        const rows = outbox[normalizedSessionId];
        if (!rows) return null;
        const index = rows.findIndex((row) => row.localId === localId);
        if (index < 0) return null;
        const existing = rows[index]!;
        if (existing.operation === 'quarantined') return existing;
        if (existing.operation === 'cancel') return existing;
        const next = { ...existing, operation: 'cancel' as const };
        const nextRows = [...rows];
        nextRows[index] = next;
        outbox[normalizedSessionId] = nextRows;
        return next;
    });
}

export async function removePendingOutboxMessage(
    sessionId: string,
    localId: string,
    scope: ServerAccountScope,
    expectedOperation?: 'enqueue' | 'cancel',
): Promise<void> {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId || readPendingLocalId(localId) === null) return;
    return updatePendingOutbox(scope, (outbox) => {
        const rows = outbox[normalizedSessionId];
        if (!rows) return;
        const nextRows = rows.filter((row) => row.localId !== localId
            || (expectedOperation !== undefined && row.operation !== expectedOperation));
        if (nextRows.length === rows.length) return;
        if (nextRows.length === 0) delete outbox[normalizedSessionId];
        else outbox[normalizedSessionId] = nextRows;
    });
}
