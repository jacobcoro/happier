import { beforeEach, describe, expect, it } from 'vitest';

import { Encryption } from '@/sync/encryption/encryption';
import { storage } from '@/sync/domains/state/storage';
import { loadPendingOutboxForSession, savePendingOutboxMessage } from '@/sync/domains/state/pendingOutboxPersistence';
import { getPersistenceStorage } from '@/sync/domains/state/persistence';
import { scopedSessionLocalStateKey } from '@/sync/domains/state/sessionLocalStateKeys';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { getPendingMessageVisualState } from '@/components/sessions/pending/pendingMessageVisualState';
import { ServerFetchWriteTimeoutError } from '@/sync/http/client';

import {
    deletePendingMessageV2,
    enqueuePendingMessageV2 as enqueuePendingMessageV2Impl,
    fetchAndApplyPendingMessagesV2,
    replayPersistedPendingOutboxForSession,
    retryPendingOutboxOperationV2 as retryPendingOutboxOperationV2Impl,
    updatePendingRequestedActionV2 as updatePendingRequestedActionV2Impl,
} from './pendingQueueV2';
import { buildSession, resetPendingQueueState, withExactPendingEnqueueAckIdentityForTest } from './pendingQueueV2.testHelpers';

const enqueuePendingMessageV2 = (
    params: Omit<Parameters<typeof enqueuePendingMessageV2Impl>[0], 'wireMode'>,
) => enqueuePendingMessageV2Impl({
    ...params,
    request: withExactPendingEnqueueAckIdentityForTest(params.request),
    wireMode: 'pending_input_v1',
});
const retryPendingOutboxOperationV2 = (
    params: Omit<Parameters<typeof retryPendingOutboxOperationV2Impl>[0], 'wireMode'>,
) => retryPendingOutboxOperationV2Impl({
    ...params,
    request: withExactPendingEnqueueAckIdentityForTest(params.request),
    wireMode: 'pending_input_v1',
});
const updatePendingRequestedActionV2 = (
    params: Omit<Parameters<typeof updatePendingRequestedActionV2Impl>[0], 'wireMode'>,
) => updatePendingRequestedActionV2Impl({ ...params, wireMode: 'pending_input_v1' });

function body(localId: string, text: string): string {
    return JSON.stringify({
        localId,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text }, meta: {} } },
        messageRole: 'user',
        requestedAction: { v: 1, kind: 'enqueue' },
    });
}

async function persist(params: Readonly<{
    sessionId: string;
    localId: string;
    text: string;
    scope: Readonly<{ serverId: string; accountId: string }>;
    operation: 'enqueue' | 'cancel';
}>): Promise<void> {
    (await savePendingOutboxMessage({
        sessionId: params.sessionId,
        localId: params.localId,
        createdAt: 111,
        text: params.text,
        rawRecord: { role: 'user', content: { type: 'text', text: params.text }, meta: {} },
        operation: params.operation,
        request: { v: 1, body: body(params.localId, params.text) },
    }, params.scope));
    (await replayPersistedPendingOutboxForSession(params.sessionId, params.scope));
}

function response(localId: string, status: 'queued' | 'discarded', text = `server ${status}`): Response {
    return new Response(JSON.stringify({
        pending: [{
            localId,
            content: {
                t: 'plain',
                v: { role: 'user', content: { type: 'text', text }, meta: {} },
            },
            requestedAction: { v: 1, kind: 'enqueue' },
            status,
            position: 0,
            createdAt: 222,
            updatedAt: 223,
            discardedAt: status === 'discarded' ? 223 : null,
            discardedReason: status === 'discarded' ? 'manual' : null,
        }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('pendingQueueV2 scoped refresh reconciliation', () => {
    beforeEach(() => resetPendingQueueState());

    it('rejects an older refresh when a newer refresh starts while scope validation is awaited', async () => {
        const sessionId = 'awaited-scope-refresh-session';
        const server = upsertServerProfile({ serverUrl: 'https://awaited-scope.example.test', name: 'Awaited scope' });
        const scope = { serverId: server.id, accountId: 'account' } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        let releaseOlderScopeCheck!: () => void;
        const olderScopeCheck = new Promise<boolean>((resolve) => {
            releaseOlderScopeCheck = () => resolve(true);
        });
        let olderScopeCheckStarted!: () => void;
        const olderScopeCheckStartedGate = new Promise<void>((resolve) => { olderScopeCheckStarted = resolve; });
        let olderScopeCheckCount = 0;
        const encryption = await Encryption.create(new Uint8Array(32).fill(6));

        const olderRefresh = fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => {
                olderScopeCheckCount += 1;
                if (olderScopeCheckCount < 3) return true;
                olderScopeCheckStarted();
                return olderScopeCheck;
            },
            request: async () => response('older-local', 'queued', 'older snapshot'),
        });
        await olderScopeCheckStartedGate;

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => response('newer-local', 'queued', 'newer snapshot'),
        });
        releaseOlderScopeCheck();
        await olderRefresh;

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId: 'newer-local', text: 'newer snapshot' }),
        ]);
    });

    it('rejects a held A response after active server changes while profile scope is still A', async () => {
        const sessionId = 'transition-gap-session';
        const localId = 'transition-gap-local';
        const serverA = upsertServerProfile({ serverUrl: 'https://transition-a.example.test', name: 'A' });
        const serverB = upsertServerProfile({ serverUrl: 'https://transition-b.example.test', name: 'B' });
        const scopeA = { serverId: serverA.id, accountId: 'account-a' } as const;
        const scopeB = { serverId: serverB.id, accountId: 'account-b' } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        setActiveServerId(serverA.id, { scope: 'tab' });
        storage.getState().activateProfileScope(scopeA);
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));
        const refresh = fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: scopeA,
            request: async () => {
                await held;
                return response(localId, 'queued');
            },
        });

        setActiveServerId(serverB.id, { scope: 'tab' });
        (await persist({ sessionId, localId, text: 'scope B durable', scope: scopeB, operation: 'enqueue' }));
        release();
        await refresh;

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ text: 'scope B durable', pendingOutboxScope: scopeB }),
        ]);
    });

    it('keeps local-only durable custody when the server snapshot has not proven persistence', async () => {
        const sessionId = 'local-only-session';
        const localId = 'local-only-local';
        const server = upsertServerProfile({ serverUrl: 'https://local-only.example.test', name: 'Local only' });
        const scope = { serverId: server.id, accountId: 'account' } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        setActiveServerId(server.id, { scope: 'tab' });
        storage.getState().activateProfileScope(scope);
        (await persist({ sessionId, localId, text: 'still saving', scope, operation: 'enqueue' }));
        const encryption = await Encryption.create(new Uint8Array(32).fill(8));

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => new Response(JSON.stringify({ pending: [] }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        });

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                source: 'local_outbound',
                text: 'still saving',
                pendingOutboxScope: scope,
            }),
        ]);
    });

    it('retains one scoped projection when durable enqueue custody overlaps unresolved external handoff state', async () => {
        const sessionId = 'retained-outbox-external-overlap-session';
        const localId = 'retained-outbox-external-overlap-local';
        const server = upsertServerProfile({ serverUrl: 'https://external-overlap.example.test', name: 'External overlap' });
        const scope = { serverId: server.id, accountId: 'account' } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        setActiveServerId(server.id, { scope: 'tab' });
        storage.getState().activateProfileScope(scope);
        (await persist({ sessionId, localId, text: 'retained external handoff', scope, operation: 'enqueue' }));
        const retained = storage.getState().sessionPending[sessionId]?.messages[0];
        storage.getState().upsertPendingMessage(sessionId, {
            ...retained!,
            pendingDeliveryStatus: 'external_handoff',
        });
        const encryption = await Encryption.create(new Uint8Array(32).fill(18));

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({ pending: [] }),
        });

        expect((await loadPendingOutboxForSession(sessionId, scope))).toEqual([
            expect.objectContaining({ localId, operation: 'enqueue' }),
        ]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                source: 'local_outbound',
                pendingDeliveryStatus: 'external_handoff',
                pendingOutboxScope: scope,
            }),
        ]);
    });

    it('retires durable enqueue custody once its scoped external handoff projection is acknowledged', async () => {
        const sessionId = 'acknowledged-external-handoff-outbox-session';
        const localId = 'acknowledged-external-handoff-outbox-local';
        const server = upsertServerProfile({ serverUrl: 'https://acknowledged-external.example.test', name: 'Acknowledged external' });
        const scope = { serverId: server.id, accountId: 'account' } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        setActiveServerId(server.id, { scope: 'tab' });
        storage.getState().activateProfileScope(scope);
        (await persist({ sessionId, localId, text: 'acknowledged external handoff', scope, operation: 'enqueue' }));
        const retained = storage.getState().sessionPending[sessionId]?.messages[0];
        storage.getState().upsertPendingMessage(sessionId, {
            ...retained!,
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'external_handoff',
            sendState: undefined,
        });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await Encryption.create(new Uint8Array(32).fill(19)),
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({ pending: [] }),
        });

        expect((await loadPendingOutboxForSession(sessionId, scope))).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                deliveryStatus: 'accepted',
                pendingDeliveryStatus: 'external_handoff',
                pendingOutboxScope: scope,
            }),
        ]);
    });

    it('prefers a canonical server external handoff over an acknowledged local enqueue duplicate', async () => {
        const sessionId = 'canonical-external-over-accepted-local-session';
        const localId = 'canonical-external-over-accepted-local-id';
        const server = upsertServerProfile({ serverUrl: 'https://canonical-external.example.test', name: 'Canonical external' });
        const scope = { serverId: server.id, accountId: 'account' } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        setActiveServerId(server.id, { scope: 'tab' });
        storage.getState().activateProfileScope(scope);
        (await persist({ sessionId, localId, text: 'stale acknowledged local', scope, operation: 'enqueue' }));
        const localProjection = storage.getState().sessionPending[sessionId]?.messages[0];
        storage.getState().upsertPendingMessage(sessionId, {
            ...localProjection!,
            deliveryStatus: 'accepted',
            sendState: undefined,
        });
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'canonical-external-synthetic-projection',
            localId,
            createdAt: 222,
            updatedAt: 223,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'external_handoff',
            pendingOutboxScope: scope,
            text: 'canonical external content',
            rawRecord: {
                role: 'user',
                content: { type: 'text', text: 'canonical external content' },
                meta: { owner: 'server' },
            },
        });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await Encryption.create(new Uint8Array(32).fill(24)),
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({ pending: [] }),
        });

        expect((await loadPendingOutboxForSession(sessionId, scope))).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                id: 'canonical-external-synthetic-projection',
                localId,
                source: 'server_pending',
                pendingDeliveryStatus: 'external_handoff',
                text: 'canonical external content',
                rawRecord: expect.objectContaining({ meta: { owner: 'server' } }),
            }),
        ]);
    });

    it('does not rebuild durable cancel custody beside a retained scoped server handoff', async () => {
        const sessionId = 'server-handoff-cancel-dedup-session';
        const localId = 'server-handoff-cancel-dedup-local';
        const server = upsertServerProfile({ serverUrl: 'https://server-handoff-cancel.example.test', name: 'Server handoff cancel' });
        const scope = { serverId: server.id, accountId: 'account' } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        setActiveServerId(server.id, { scope: 'tab' });
        storage.getState().activateProfileScope(scope);
        (await savePendingOutboxMessage({
            sessionId,
            localId,
            createdAt: 111,
            text: 'cancel retained handoff',
            rawRecord: { role: 'user', content: { type: 'text', text: 'cancel retained handoff' }, meta: {} },
            operation: 'cancel',
            request: { v: 1, body: body(localId, 'cancel retained handoff') },
        }, scope));
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'server-handoff-cancel-synthetic-projection',
            localId,
            createdAt: 222,
            updatedAt: 222,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'external_handoff',
            pendingOutboxScope: scope,
            text: 'server handoff remains canonical',
            rawRecord: { role: 'user', content: { type: 'text', text: 'server handoff remains canonical' }, meta: {} },
        });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await Encryption.create(new Uint8Array(32).fill(20)),
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({ pending: [] }),
        });

        expect((await loadPendingOutboxForSession(sessionId, scope))).toEqual([
            expect.objectContaining({ localId, operation: 'cancel' }),
        ]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                id: 'server-handoff-cancel-synthetic-projection',
                localId,
                source: 'server_pending',
                pendingDeliveryStatus: 'external_handoff',
            }),
        ]);
    });

    it('serializes acknowledged refresh retirement behind a held retry and preserves canonical handoff content', async () => {
        const sessionId = 'held-retry-canonical-handoff-session';
        const localId = 'held-retry-canonical-handoff-local';
        const server = upsertServerProfile({ serverUrl: 'https://held-retry-handoff.example.test', name: 'Held retry handoff' });
        const scope = { serverId: server.id, accountId: 'account' } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        setActiveServerId(server.id, { scope: 'tab' });
        storage.getState().activateProfileScope(scope);
        (await persist({ sessionId, localId, text: 'stale retry content', scope, operation: 'enqueue' }));
        let retryStarted!: () => void;
        const retryStartedGate = new Promise<void>((resolve) => { retryStarted = resolve; });
        let releaseRetry!: () => void;
        const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
        const retry = retryPendingOutboxOperationV2({
            sessionId,
            localId,
            outboxScope: scope,
            request: async () => {
                retryStarted();
                await retryGate;
                return Response.json({ requestedAction: { v: 1, kind: 'enqueue' } });
            },
        });
        await retryStartedGate;

        let refreshSettled = false;
        const refresh = fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await Encryption.create(new Uint8Array(32).fill(21)),
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({
                pending: [{
                    localId,
                    content: {
                        t: 'plain',
                        v: { role: 'user', content: { type: 'text', text: 'canonical server handoff' }, meta: { owner: 'server' } },
                    },
                    requestedAction: { v: 1, kind: 'enqueue' },
                    status: 'queued',
                    deliveryState: 'external_handoff',
                    deliveryStatus: { status: 'external_handoff' },
                    position: 0,
                    createdAt: 222,
                    updatedAt: 223,
                    discardedAt: null,
                    discardedReason: null,
                }],
            }),
        }).then(() => { refreshSettled = true; });
        await refresh;
        expect(refreshSettled).toBe(true);
        expect((await loadPendingOutboxForSession(sessionId, scope))).toEqual([]);

        releaseRetry();
        await Promise.all([retry, refresh]);

        expect((await loadPendingOutboxForSession(sessionId, scope))).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                source: 'server_pending',
                pendingDeliveryStatus: 'external_handoff',
                text: 'canonical server handoff',
                rawRecord: expect.objectContaining({ meta: { owner: 'server' } }),
            }),
        ]);
    });

    it('does not overwrite an authoritative handoff when refresh retires custody during the cancellation-helper yield', async () => {
        const sessionId = 'refresh-retirement-during-cancellation-helper-session';
        const localId = 'refresh-retirement-during-cancellation-helper-local';
        const server = upsertServerProfile({ serverUrl: 'https://refresh-cancellation-helper.example.test', name: 'Refresh cancellation helper' });
        const scope = { serverId: server.id, accountId: 'account' } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        setActiveServerId(server.id, { scope: 'tab' });
        storage.getState().activateProfileScope(scope);
        (await persist({ sessionId, localId, text: 'stale retry content', scope, operation: 'enqueue' }));

        let finalScopeCheckStarted!: () => void;
        const finalScopeCheckStartedGate = new Promise<void>((resolve) => { finalScopeCheckStarted = resolve; });
        let releaseFinalScopeCheck!: () => void;
        const finalScopeCheckGate = new Promise<boolean>((resolve) => { releaseFinalScopeCheck = () => resolve(true); });
        let scopeCheckCount = 0;
        const refresh = fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await Encryption.create(new Uint8Array(32).fill(26)),
            outboxScope: scope,
            isOutboxScopeCurrent: () => {
                scopeCheckCount += 1;
                if (scopeCheckCount < 3) return true;
                finalScopeCheckStarted();
                return finalScopeCheckGate;
            },
            request: async () => Response.json({
                pending: [{
                    localId,
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'authoritative handoff' }, meta: { owner: 'server' } } },
                    requestedAction: { v: 1, kind: 'enqueue' },
                    status: 'queued',
                    deliveryState: 'external_handoff',
                    deliveryStatus: { status: 'external_handoff' },
                    position: 0,
                    createdAt: 222,
                    updatedAt: 223,
                    discardedAt: null,
                    discardedReason: null,
                }],
            }),
        });
        await finalScopeCheckStartedGate;

        const retry = retryPendingOutboxOperationV2({
            sessionId,
            localId,
            outboxScope: scope,
            request: async () => {
                const payload = {
                    pending: { localId },
                    requestedAction: { v: 1, kind: 'enqueue' },
                };
                const acknowledgment = Response.json(payload);
                Object.defineProperty(acknowledgment, 'json', {
                    value: () => {
                        queueMicrotask(releaseFinalScopeCheck);
                        return Promise.resolve(payload);
                    },
                });
                return acknowledgment;
            },
        });
        await Promise.all([retry, refresh]);

        expect((await loadPendingOutboxForSession(sessionId, scope))).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                source: 'server_pending',
                pendingDeliveryStatus: 'external_handoff',
                text: 'authoritative handoff',
                rawRecord: expect.objectContaining({ meta: { owner: 'server' } }),
            }),
        ]);
    });

    it('does not overwrite an authoritative handoff when refresh retires initial enqueue custody during the cancellation-helper yield', async () => {
        const sessionId = 'initial-enqueue-refresh-retirement-during-cancellation-helper-session';
        const localId = 'initial-enqueue-refresh-retirement-during-cancellation-helper-local';
        const server = upsertServerProfile({ serverUrl: 'https://initial-enqueue-refresh-cancellation-helper.example.test', name: 'Initial enqueue refresh cancellation helper' });
        const scope = { serverId: server.id, accountId: 'account' } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        setActiveServerId(server.id, { scope: 'tab' });
        storage.getState().activateProfileScope(scope);

        let finalScopeCheckStarted!: () => void;
        const finalScopeCheckStartedGate = new Promise<void>((resolve) => { finalScopeCheckStarted = resolve; });
        let releaseFinalScopeCheck!: () => void;
        const finalScopeCheckGate = new Promise<boolean>((resolve) => { releaseFinalScopeCheck = () => resolve(true); });
        let scopeCheckCount = 0;
        const refresh = fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await Encryption.create(new Uint8Array(32).fill(27)),
            outboxScope: scope,
            isOutboxScopeCurrent: () => {
                scopeCheckCount += 1;
                if (scopeCheckCount < 3) return true;
                finalScopeCheckStarted();
                return finalScopeCheckGate;
            },
            request: async () => Response.json({
                pending: [{
                    localId,
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'authoritative initial-enqueue handoff' }, meta: { owner: 'server' } } },
                    requestedAction: { v: 1, kind: 'enqueue' },
                    status: 'queued',
                    deliveryState: 'external_handoff',
                    deliveryStatus: { status: 'external_handoff' },
                    position: 0,
                    createdAt: 222,
                    updatedAt: 223,
                    discardedAt: null,
                    discardedReason: null,
                }],
            }),
        });
        await finalScopeCheckStartedGate;

        const enqueue = enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'stale initial enqueue content',
            encryption: await Encryption.create(new Uint8Array(32).fill(28)),
            outboxScope: scope,
            requestedAction: { v: 1, kind: 'enqueue' },
            request: async () => {
                const payload = {
                    pending: { localId },
                    requestedAction: { v: 1, kind: 'enqueue' },
                };
                const acknowledgment = Response.json(payload);
                Object.defineProperty(acknowledgment, 'json', {
                    value: () => {
                        queueMicrotask(releaseFinalScopeCheck);
                        return Promise.resolve(payload);
                    },
                });
                return acknowledgment;
            },
        });
        await Promise.all([enqueue, refresh]);

        expect((await loadPendingOutboxForSession(sessionId, scope))).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                source: 'server_pending',
                pendingDeliveryStatus: 'external_handoff',
                text: 'authoritative initial-enqueue handoff',
                rawRecord: expect.objectContaining({ meta: { owner: 'server' } }),
            }),
        ]);
    });

    it.each([
        ['initial enqueue', 'during the cancellation-helper yield', 3],
        ['retry', 'during the cancellation-helper yield', 3],
        ['initial enqueue', 'after final enqueue proof before owner release', 4],
        ['retry', 'after final enqueue proof before owner release', 4],
    ] as const)(
        'routes a late %s cancellation that starts %s',
        async (operationKind, timing, cancellationMicrotaskHops) => {
            const caseId = `${timing.replaceAll(' ', '-')}-${operationKind.replaceAll(' ', '-')}`;
            const sessionId = `late-cancellation-${caseId}-session`;
            const localId = `late-cancellation-${caseId}-local`;
            const server = upsertServerProfile({ serverUrl: `https://${sessionId}.example.test`, name: sessionId });
            const scope = { serverId: server.id, accountId: 'account' } as const;
            storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
            setActiveServerId(server.id, { scope: 'tab' });
            storage.getState().activateProfileScope(scope);
            if (operationKind === 'retry') {
                (await persist({ sessionId, localId, text: 'durable retry content', scope, operation: 'enqueue' }));
            }

            const transportRequests: string[] = [];
            let cancellation!: Promise<void>;
            let cancellationStarted!: () => void;
            const cancellationStartedGate = new Promise<void>((resolve) => { cancellationStarted = resolve; });
            const startCancellationAfterHops = (remainingHops: number): void => {
                if (remainingHops > 0) {
                    queueMicrotask(() => startCancellationAfterHops(remainingHops - 1));
                    return;
                }
                cancellation = deletePendingMessageV2({
                    sessionId,
                    pendingId: localId,
                    outboxScope: scope,
                    request: async (path, init) => {
                        transportRequests.push(`${init?.method ?? 'GET'} ${path}`);
                        return new Response(null, { status: 200 });
                    },
                });
                cancellationStarted();
            };
            const acknowledgedPost = async (path: string, init?: RequestInit): Promise<Response> => {
                transportRequests.push(`${init?.method ?? 'GET'} ${path}`);
                if (init?.method === 'DELETE') return new Response(null, { status: 200 });
                const payload = {
                    pending: { localId },
                    requestedAction: { v: 1, kind: 'enqueue' },
                };
                const acknowledgment = Response.json(payload);
                Object.defineProperty(acknowledgment, 'json', {
                    value: () => {
                        startCancellationAfterHops(cancellationMicrotaskHops);
                        return Promise.resolve(payload);
                    },
                });
                return acknowledgment;
            };

            const operation = operationKind === 'initial enqueue'
                ? enqueuePendingMessageV2({
                    sessionId,
                    localId,
                    text: 'initial enqueue content',
                    encryption: await Encryption.create(new Uint8Array(32).fill(29)),
                    outboxScope: scope,
                    requestedAction: { v: 1, kind: 'enqueue' },
                    request: acknowledgedPost,
                })
                : retryPendingOutboxOperationV2({
                    sessionId,
                    localId,
                    outboxScope: scope,
                    request: acknowledgedPost,
                });

            await cancellationStartedGate;
            const [operationResult] = await Promise.all([operation, cancellation]);

            expect(transportRequests.filter((entry) => entry.startsWith('DELETE '))).toEqual([
                `DELETE /v2/sessions/${sessionId}/pending/${localId}`,
            ]);
            if (operationKind === 'initial enqueue') {
                expect(operationResult).toMatchObject({ localId, accepted: true });
            } else {
                expect(operationResult).toEqual({ accepted: true });
            }
            expect((await loadPendingOutboxForSession(sessionId, scope))).toEqual([]);
            expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
        },
    );

    it.each([
        ['empty', null],
        ['unrelated', 'unrelated-server-local'],
    ] as const)('suppresses an older %s refresh after retry retires accepted custody', async (snapshotKind, snapshotLocalId) => {
        const sessionId = `retry-suppresses-older-${snapshotKind}-refresh-session`;
        const localId = `retry-suppresses-older-${snapshotKind}-refresh-local`;
        const server = upsertServerProfile({ serverUrl: `https://retry-suppresses-${snapshotKind}-refresh.example.test`, name: `Retry suppresses ${snapshotKind} refresh` });
        const scope = { serverId: server.id, accountId: 'account' } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        setActiveServerId(server.id, { scope: 'tab' });
        storage.getState().activateProfileScope(scope);
        (await persist({ sessionId, localId, text: 'accepted retry content', scope, operation: 'enqueue' }));

        let finalScopeCheckStarted!: () => void;
        const finalScopeCheckStartedGate = new Promise<void>((resolve) => { finalScopeCheckStarted = resolve; });
        let releaseFinalScopeCheck!: () => void;
        const finalScopeCheckGate = new Promise<boolean>((resolve) => { releaseFinalScopeCheck = () => resolve(true); });
        let scopeCheckCount = 0;
        const olderRefresh = fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await Encryption.create(new Uint8Array(32).fill(30)),
            outboxScope: scope,
            isOutboxScopeCurrent: () => {
                scopeCheckCount += 1;
                if (scopeCheckCount < 3) return true;
                finalScopeCheckStarted();
                return finalScopeCheckGate;
            },
            request: async () => Response.json({
                pending: snapshotLocalId === null ? [] : [{
                    localId: snapshotLocalId,
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'unrelated server content' }, meta: {} } },
                    requestedAction: { v: 1, kind: 'enqueue' },
                    status: 'queued',
                    position: 0,
                    createdAt: 222,
                    updatedAt: 223,
                    discardedAt: null,
                    discardedReason: null,
                }],
            }),
        });
        await finalScopeCheckStartedGate;

        await retryPendingOutboxOperationV2({
            sessionId,
            localId,
            outboxScope: scope,
            request: async () => Response.json({ requestedAction: { v: 1, kind: 'enqueue' } }),
        });
        expect((await loadPendingOutboxForSession(sessionId, scope))).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                deliveryStatus: 'accepted',
                text: 'accepted retry content',
            }),
        ]);

        releaseFinalScopeCheck();
        await olderRefresh;

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                deliveryStatus: 'accepted',
                text: 'accepted retry content',
            }),
        ]);
    });

    it('suppresses an unrelated older refresh parsed after retry acceptance', async () => {
        const sessionId = 'retry-acceptance-before-unrelated-parse-session';
        const localId = 'retry-acceptance-before-unrelated-parse-local';
        const server = upsertServerProfile({ serverUrl: 'https://retry-acceptance-before-parse.example.test', name: 'Retry acceptance before parse' });
        const scope = { serverId: server.id, accountId: 'account' } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        setActiveServerId(server.id, { scope: 'tab' });
        storage.getState().activateProfileScope(scope);
        (await persist({ sessionId, localId, text: 'accepted before parse', scope, operation: 'enqueue' }));

        let parseStarted!: () => void;
        const parseStartedGate = new Promise<void>((resolve) => { parseStarted = resolve; });
        let releaseParse!: () => void;
        const parseGate = new Promise<void>((resolve) => { releaseParse = resolve; });
        const olderUnrelatedRefresh = fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await Encryption.create(new Uint8Array(32).fill(33)),
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => {
                const snapshot = {
                    pending: [{
                        localId: 'retry-acceptance-before-unrelated-parse-other',
                        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'unrelated parsed content' }, meta: {} } },
                        requestedAction: { v: 1, kind: 'enqueue' },
                        status: 'queued',
                        position: 0,
                        createdAt: 222,
                        updatedAt: 223,
                        discardedAt: null,
                        discardedReason: null,
                    }],
                };
                const result = Response.json(snapshot);
                Object.defineProperty(result, 'json', {
                    value: async () => {
                        parseStarted();
                        await parseGate;
                        return snapshot;
                    },
                });
                return result;
            },
        });
        await parseStartedGate;

        await retryPendingOutboxOperationV2({
            sessionId,
            localId,
            outboxScope: scope,
            request: async () => Response.json({ requestedAction: { v: 1, kind: 'enqueue' } }),
        });
        releaseParse();
        await olderUnrelatedRefresh;

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                deliveryStatus: 'accepted',
                text: 'accepted before parse',
            }),
        ]);
    });

    it.each(['initial enqueue', 'retry'] as const)(
        'allows an older exact canonical row to converge after %s acceptance',
        async (operationKind) => {
            const caseId = operationKind.replaceAll(' ', '-');
            const sessionId = `older-exact-canonical-after-${caseId}-session`;
            const localId = `older-exact-canonical-after-${caseId}-local`;
            const server = upsertServerProfile({ serverUrl: `https://${sessionId}.example.test`, name: sessionId });
            const scope = { serverId: server.id, accountId: 'account' } as const;
            storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
            setActiveServerId(server.id, { scope: 'tab' });
            storage.getState().activateProfileScope(scope);
            if (operationKind === 'retry') {
                (await persist({ sessionId, localId, text: 'local retry content', scope, operation: 'enqueue' }));
            }

            let finalScopeCheckStarted!: () => void;
            const finalScopeCheckStartedGate = new Promise<void>((resolve) => { finalScopeCheckStarted = resolve; });
            let releaseFinalScopeCheck!: () => void;
            const finalScopeCheckGate = new Promise<boolean>((resolve) => { releaseFinalScopeCheck = () => resolve(true); });
            let scopeCheckCount = 0;
            const olderExactRefresh = fetchAndApplyPendingMessagesV2({
                sessionId,
                encryption: await Encryption.create(new Uint8Array(32).fill(31)),
                outboxScope: scope,
                isOutboxScopeCurrent: () => {
                    scopeCheckCount += 1;
                    if (scopeCheckCount < 3) return true;
                    finalScopeCheckStarted();
                    return finalScopeCheckGate;
                },
                request: async () => response(localId, 'queued', 'canonical server content'),
            });
            await finalScopeCheckStartedGate;

            if (operationKind === 'initial enqueue') {
                await enqueuePendingMessageV2({
                    sessionId,
                    localId,
                    text: 'local initial content',
                    encryption: await Encryption.create(new Uint8Array(32).fill(32)),
                    outboxScope: scope,
                    requestedAction: { v: 1, kind: 'enqueue' },
                    request: async () => Response.json({ requestedAction: { v: 1, kind: 'enqueue' } }),
                });
            } else {
                await retryPendingOutboxOperationV2({
                    sessionId,
                    localId,
                    outboxScope: scope,
                    request: async () => Response.json({ requestedAction: { v: 1, kind: 'enqueue' } }),
                });
            }

            releaseFinalScopeCheck();
            await olderExactRefresh;

            expect((await loadPendingOutboxForSession(sessionId, scope))).toEqual([]);
            expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
                expect.objectContaining({
                    localId,
                    source: 'server_pending',
                    text: 'canonical server content',
                }),
            ]);
        },
    );

    it.each([
        ['partial', false],
        ['all', true],
    ] as const)('requires %s accepted-ID coverage before applying a held canonical snapshot', async (coverage, shouldApplySnapshot) => {
        const sessionId = `held-${coverage}-accepted-id-coverage-session`;
        const localIdA = `held-${coverage}-accepted-id-a`;
        const localIdB = `held-${coverage}-accepted-id-b`;
        const server = upsertServerProfile({ serverUrl: `https://${sessionId}.example.test`, name: sessionId });
        const scope = { serverId: server.id, accountId: 'account' } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        setActiveServerId(server.id, { scope: 'tab' });
        storage.getState().activateProfileScope(scope);
        (await persist({ sessionId, localId: localIdA, text: 'local accepted a', scope, operation: 'enqueue' }));
        (await persist({ sessionId, localId: localIdB, text: 'local accepted b', scope, operation: 'enqueue' }));

        let finalScopeCheckStarted!: () => void;
        const finalScopeCheckStartedGate = new Promise<void>((resolve) => { finalScopeCheckStarted = resolve; });
        let releaseFinalScopeCheck!: () => void;
        const finalScopeCheckGate = new Promise<boolean>((resolve) => { releaseFinalScopeCheck = () => resolve(true); });
        let scopeCheckCount = 0;
        const snapshotLocalIds = shouldApplySnapshot ? [localIdA, localIdB] : [localIdA];
        const heldSnapshot = fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await Encryption.create(new Uint8Array(32).fill(34)),
            outboxScope: scope,
            isOutboxScopeCurrent: () => {
                scopeCheckCount += 1;
                if (scopeCheckCount < 3) return true;
                finalScopeCheckStarted();
                return finalScopeCheckGate;
            },
            request: async () => Response.json({
                pending: snapshotLocalIds.map((snapshotLocalId, position) => ({
                    localId: snapshotLocalId,
                    content: {
                        t: 'plain',
                        v: { role: 'user', content: { type: 'text', text: snapshotLocalId === localIdA ? 'canonical a' : 'canonical b' }, meta: {} },
                    },
                    requestedAction: { v: 1, kind: 'enqueue' },
                    status: 'queued',
                    position,
                    createdAt: 222 + position,
                    updatedAt: 223 + position,
                    discardedAt: null,
                    discardedReason: null,
                })),
            }),
        });
        await finalScopeCheckStartedGate;

        for (const localId of [localIdA, localIdB]) {
            await retryPendingOutboxOperationV2({
                sessionId,
                localId,
                outboxScope: scope,
                request: async () => Response.json({ requestedAction: { v: 1, kind: 'enqueue' } }),
            });
        }
        releaseFinalScopeCheck();
        await heldSnapshot;

        const messages = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(messages).toHaveLength(2);
        expect(messages).toEqual(expect.arrayContaining(shouldApplySnapshot
            ? [
                expect.objectContaining({ localId: localIdA, source: 'server_pending', text: 'canonical a' }),
                expect.objectContaining({ localId: localIdB, source: 'server_pending', text: 'canonical b' }),
            ]
            : [
                expect.objectContaining({ localId: localIdA, source: 'local_outbound', text: 'local accepted a' }),
                expect.objectContaining({ localId: localIdB, source: 'local_outbound', text: 'local accepted b' }),
            ]));
    });

    it('suppresses an unrelated older refresh when retry acceptance occurs during decrypt', async () => {
        const sessionId = 'retry-acceptance-during-unrelated-decrypt-session';
        const localId = 'retry-acceptance-during-unrelated-decrypt-local';
        const unrelatedLocalId = 'retry-acceptance-during-unrelated-decrypt-other';
        const server = upsertServerProfile({ serverUrl: 'https://retry-acceptance-during-decrypt.example.test', name: 'Retry acceptance during decrypt' });
        const scope = { serverId: server.id, accountId: 'account' } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'e2ee' }]);
        setActiveServerId(server.id, { scope: 'tab' });
        storage.getState().activateProfileScope(scope);
        (await persist({ sessionId, localId, text: 'accepted during decrypt', scope, operation: 'enqueue' }));

        let decryptStarted!: () => void;
        const decryptStartedGate = new Promise<void>((resolve) => { decryptStarted = resolve; });
        let releaseDecrypt!: () => void;
        const decryptGate = new Promise<void>((resolve) => { releaseDecrypt = resolve; });
        const encryption = {
            getSessionEncryption: () => ({
                decryptRaw: async () => {
                    decryptStarted();
                    await decryptGate;
                    return { role: 'user', content: { type: 'text', text: 'unrelated decrypted content' }, meta: {} };
                },
            }),
        } as unknown as Encryption;
        const olderUnrelatedRefresh = fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({
                pending: [{
                    localId: unrelatedLocalId,
                    content: { t: 'encrypted', c: 'unrelated-ciphertext' },
                    requestedAction: { v: 1, kind: 'enqueue' },
                    status: 'queued',
                    position: 0,
                    createdAt: 222,
                    updatedAt: 223,
                    discardedAt: null,
                    discardedReason: null,
                }],
            }),
        });
        await decryptStartedGate;

        await retryPendingOutboxOperationV2({
            sessionId,
            localId,
            outboxScope: scope,
            request: async () => Response.json({ requestedAction: { v: 1, kind: 'enqueue' } }),
        });
        releaseDecrypt();
        await olderUnrelatedRefresh;

        expect((await loadPendingOutboxForSession(sessionId, scope))).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                deliveryStatus: 'accepted',
                text: 'accepted during decrypt',
            }),
        ]);
    });

    it('keeps an older authoritative external-handoff refresh eligible after retry starts', async () => {
        const sessionId = 'older-authoritative-refresh-during-retry-session';
        const localId = 'older-authoritative-refresh-during-retry-local';
        const server = upsertServerProfile({ serverUrl: 'https://older-authoritative-refresh.example.test', name: 'Older authoritative refresh' });
        const scope = { serverId: server.id, accountId: 'account' } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'e2ee' }]);
        setActiveServerId(server.id, { scope: 'tab' });
        storage.getState().activateProfileScope(scope);
        (await persist({ sessionId, localId, text: 'stale retry content', scope, operation: 'enqueue' }));
        let decryptStarted!: () => void;
        const decryptStartedGate = new Promise<void>((resolve) => { decryptStarted = resolve; });
        let releaseDecrypt!: () => void;
        const decryptGate = new Promise<void>((resolve) => { releaseDecrypt = resolve; });
        const encryption = {
            getSessionEncryption: () => ({
                decryptRaw: async () => {
                    decryptStarted();
                    await decryptGate;
                    return { role: 'user', content: { type: 'text', text: 'authoritative external handoff' }, meta: { owner: 'server' } };
                },
            }),
        } as unknown as Encryption;
        const refresh = fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({
                pending: [{
                    localId,
                    content: { t: 'encrypted', c: 'authoritative-ciphertext' },
                    requestedAction: { v: 1, kind: 'enqueue' },
                    status: 'queued',
                    deliveryState: 'external_handoff',
                    deliveryStatus: { status: 'external_handoff' },
                    position: 0,
                    createdAt: 222,
                    updatedAt: 223,
                    discardedAt: null,
                    discardedReason: null,
                }],
            }),
        });
        await decryptStartedGate;
        let releaseRetry!: () => void;
        const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
        const retry = retryPendingOutboxOperationV2({
            sessionId,
            localId,
            outboxScope: scope,
            request: async () => {
                await retryGate;
                return Response.json({ requestedAction: { v: 1, kind: 'enqueue' } });
            },
        });

        releaseDecrypt();
        await refresh;
        expect((await loadPendingOutboxForSession(sessionId, scope))).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                source: 'server_pending',
                pendingDeliveryStatus: 'external_handoff',
                text: 'authoritative external handoff',
            }),
        ]);

        releaseRetry();
        await retry;
    });

    it.each([
        ['rejected response', async (): Promise<Response> => new Response(null, { status: 500 })],
        ['malformed acknowledgement', async (): Promise<Response> => Response.json({})],
        ['transient rejection', async (): Promise<Response> => { throw new TypeError('Failed to fetch'); }],
    ])('does not mutate canonical external handoff status after retry %s retires custody concurrently', async (_label, retryResult) => {
        const sessionId = `retry-failure-after-retirement-${_label.replaceAll(' ', '-')}`;
        const localId = 'retry-failure-after-retirement-local';
        const server = upsertServerProfile({ serverUrl: `https://${sessionId}.example.test`, name: sessionId });
        const scope = { serverId: server.id, accountId: 'account' } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        setActiveServerId(server.id, { scope: 'tab' });
        storage.getState().activateProfileScope(scope);
        (await persist({ sessionId, localId, text: 'stale retry content', scope, operation: 'enqueue' }));
        let retryStarted!: () => void;
        const retryStartedGate = new Promise<void>((resolve) => { retryStarted = resolve; });
        let releaseRetry!: () => void;
        const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
        const retry = retryPendingOutboxOperationV2({
            sessionId,
            localId,
            outboxScope: scope,
            request: async () => {
                retryStarted();
                await retryGate;
                return await retryResult();
            },
        });
        await retryStartedGate;

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await Encryption.create(new Uint8Array(32).fill(25)),
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({
                pending: [{
                    localId,
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'canonical external handoff' }, meta: { owner: 'server' } } },
                    requestedAction: { v: 1, kind: 'enqueue' },
                    status: 'queued',
                    deliveryState: 'external_handoff',
                    deliveryStatus: { status: 'external_handoff' },
                    position: 0,
                    createdAt: 222,
                    updatedAt: 223,
                    discardedAt: null,
                    discardedReason: null,
                }],
            }),
        });
        expect((await loadPendingOutboxForSession(sessionId, scope))).toEqual([]);

        releaseRetry();
        await retry.catch(() => undefined);

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                source: 'server_pending',
                pendingDeliveryStatus: 'external_handoff',
                text: 'canonical external handoff',
            }),
        ]);
        expect(storage.getState().sessionPending[sessionId]?.messages[0]?.sendState).toBeUndefined();
    });

    it('reserves every retained original id while reallocating crossed projection collisions', async () => {
        const sessionId = 'retained-crossed-id-reservations-session';
        const serverProjectionId = 'retained-crossed-server-id';
        const externalProjectionId = 'retained-crossed-external-id';
        const externalLocalId = 'retained-crossed-external-local';
        const scope = { serverId: 'retained-crossed-server', accountId: 'retained-crossed-account' } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: serverProjectionId,
            localId: externalProjectionId,
            createdAt: 1,
            updatedAt: 1,
            deliveryStatus: 'accepted',
            text: 'legacy projection must move',
            rawRecord: { role: 'user', content: { type: 'text', text: 'legacy projection must move' }, meta: {} },
        });
        storage.getState().upsertPendingMessage(sessionId, {
            id: externalProjectionId,
            localId: externalLocalId,
            createdAt: 2,
            updatedAt: 2,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'external_handoff',
            pendingOutboxScope: scope,
            text: 'external projection keeps id',
            rawRecord: { role: 'user', content: { type: 'text', text: 'external projection keeps id' }, meta: {} },
        });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await Encryption.create(new Uint8Array(32).fill(22)),
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => response(serverProjectionId, 'queued', 'server collision owner'),
        });

        const messages = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(messages.find((message) => message.localId === externalLocalId)).toMatchObject({
            id: externalProjectionId,
            source: 'server_pending',
            pendingDeliveryStatus: 'external_handoff',
        });
        const legacy = messages.find((message) => message.text === 'legacy projection must move');
        expect(legacy?.id).not.toBe(serverProjectionId);
        expect(legacy?.id).not.toBe(externalProjectionId);
        expect(new Set(messages.map((message) => message.id)).size).toBe(messages.length);
    });

    it('keeps a server row canonical when its opaque localId collides with a quarantine projection id', async () => {
        const sessionId = 'quarantine-projection-id-collision-session';
        const quarantinedLocalId = 'quarantined-durable-local-id';
        const server = upsertServerProfile({ serverUrl: 'https://quarantine-collision.example.test', name: 'Quarantine collision' });
        const scope = { serverId: server.id, accountId: 'account' } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        setActiveServerId(server.id, { scope: 'tab' });
        storage.getState().activateProfileScope(scope);
        getPersistenceStorage().set(
            scopedSessionLocalStateKey('session-pending-outbox-v1', scope),
            JSON.stringify({
                [sessionId]: [{
                    localId: quarantinedLocalId,
                    createdAt: 111,
                    text: 'durable quarantine diagnostic',
                    rawRecord: { role: 'user' },
                    operation: 'replace',
                    request: {
                        v: 1,
                        body: JSON.stringify({
                            localId: quarantinedLocalId,
                            content: { t: 'plain', v: {} },
                            messageRole: 'user',
                        }),
                    },
                }],
            }),
        );

        expect((await replayPersistedPendingOutboxForSession(sessionId, scope))).toEqual([]);
        const initialDiagnostic = storage.getState().sessionPending[sessionId]?.messages[0];
        expect(initialDiagnostic).toMatchObject({
            localId: quarantinedLocalId,
            pendingOutboxQuarantineReason: 'unsupported_persisted_operation',
        });
        expect(initialDiagnostic?.id).not.toBe(quarantinedLocalId);
        const collidingServerLocalId = initialDiagnostic!.id;
        const encryption = await Encryption.create(new Uint8Array(32).fill(8));

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => response(collidingServerLocalId, 'queued', 'canonical opaque server row'),
        });

        const messages = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(messages).toHaveLength(2);
        expect(messages).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: collidingServerLocalId,
                localId: collidingServerLocalId,
                source: 'server_pending',
                text: 'canonical opaque server row',
            }),
            expect.objectContaining({
                localId: quarantinedLocalId,
                pendingOutboxQuarantineReason: 'unsupported_persisted_operation',
            }),
        ]));
        const reallocatedDiagnostic = messages.find((message) => message.pendingOutboxQuarantineReason);
        expect(reallocatedDiagnostic?.id).not.toBe(collidingServerLocalId);

        let serverMutationCalled = false;
        await updatePendingRequestedActionV2({
            sessionId,
            localId: collidingServerLocalId,
            requestedAction: { v: 1, kind: 'send_now' },
            outboxScope: scope,
            request: async () => {
                serverMutationCalled = true;
                return Response.json({ didUpdate: false });
            },
        });
        expect(serverMutationCalled).toBe(true);

        let diagnosticMutationCalled = false;
        await expect(updatePendingRequestedActionV2({
            sessionId,
            localId: reallocatedDiagnostic!.id,
            requestedAction: { v: 1, kind: 'send_now' },
            outboxScope: scope,
            request: async () => {
                diagnosticMutationCalled = true;
                return Response.json({ didUpdate: false });
            },
        })).rejects.toThrow('Persisted Pending outbox row is quarantined');
        expect(diagnosticMutationCalled).toBe(false);

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({ pending: [] }),
        });
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                id: reallocatedDiagnostic!.id,
                localId: quarantinedLocalId,
                pendingOutboxQuarantineReason: 'unsupported_persisted_operation',
            }),
        ]);
    });

    it('reconciles a compatible local projection to the same-localId server Pending row', async () => {
        const sessionId = 'pending-collision-session';
        const localId = 'pending-collision-local';
        const server = upsertServerProfile({ serverUrl: 'https://pending.example.test', name: 'Pending' });
        const scope = { serverId: server.id, accountId: 'account' } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        setActiveServerId(server.id, { scope: 'tab' });
        storage.getState().activateProfileScope(scope);
        (await persist({ sessionId, localId, text: 'same content', scope, operation: 'enqueue' }));
        const encryption = await Encryption.create(new Uint8Array(32).fill(9));

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => response(localId, 'queued', 'same content'),
        });

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                source: 'server_pending',
                text: 'same content',
            }),
        ]);
        expect(storage.getState().sessionPending[sessionId]?.messages[0]).not.toHaveProperty('pendingOutboxScope');
        expect((await replayPersistedPendingOutboxForSession(sessionId, scope))).toEqual([]);
    });

    it('keeps exact-scope cancellation custody when the server only reports a discard', async () => {
        const sessionId = 'discarded-collision-session';
        const localId = 'discarded-collision-local';
        const server = upsertServerProfile({ serverUrl: 'https://discarded.example.test', name: 'Discarded' });
        const scope = { serverId: server.id, accountId: 'account' } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        setActiveServerId(server.id, { scope: 'tab' });
        storage.getState().activateProfileScope(scope);
        (await persist({ sessionId, localId, text: 'durable cancel', scope, operation: 'cancel' }));
        const encryption = await Encryption.create(new Uint8Array(32).fill(8));

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => response(localId, 'discarded'),
        });

        expect(storage.getState().sessionPending[sessionId]).toEqual(expect.objectContaining({
            messages: [],
            discarded: [expect.objectContaining({
                localId,
                source: 'server_pending',
                text: 'server discarded',
            })],
        }));
        expect((await replayPersistedPendingOutboxForSession(sessionId, scope))).toEqual([localId]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([]);
        expect((await loadPendingOutboxForSession(sessionId, scope))).toEqual([
            expect.objectContaining({ localId, operation: 'cancel' }),
        ]);

        (await savePendingOutboxMessage({
            sessionId,
            localId,
            createdAt: 333,
            text: 'stale recreated envelope',
            rawRecord: { role: 'user', content: { type: 'text', text: 'stale recreated envelope' }, meta: {} },
            operation: 'enqueue',
            request: { v: 1, body: body(localId, 'stale recreated envelope') },
        }, scope));
        expect((await replayPersistedPendingOutboxForSession(sessionId, scope))).toEqual([localId]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([]);
        expect((await loadPendingOutboxForSession(sessionId, scope))).toEqual([
            expect.objectContaining({ localId, operation: 'cancel', text: 'durable cancel' }),
        ]);
    });

    it('retires exact-scope enqueue custody when the server reports the row as discarded', async () => {
        const sessionId = 'discarded-enqueue-collision-session';
        const localId = 'discarded-enqueue-collision-local';
        const server = upsertServerProfile({ serverUrl: 'https://discarded-enqueue.example.test', name: 'Discarded enqueue' });
        const scope = { serverId: server.id, accountId: 'account' } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        setActiveServerId(server.id, { scope: 'tab' });
        storage.getState().activateProfileScope(scope);
        (await persist({ sessionId, localId, text: 'durable enqueue', scope, operation: 'enqueue' }));
        const encryption = await Encryption.create(new Uint8Array(32).fill(8));

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => response(localId, 'discarded'),
        });

        expect((await loadPendingOutboxForSession(sessionId, scope))).toEqual([]);
        expect((await replayPersistedPendingOutboxForSession(sessionId, scope))).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]).toEqual(expect.objectContaining({
            messages: [],
            discarded: [expect.objectContaining({ localId, source: 'server_pending' })],
        }));
    });

    it('keeps conflicting server content authoritative and retires executable enqueue custody', async () => {
        const sessionId = 'conflicting-collision-session';
        const localId = 'conflicting-collision-local';
        const server = upsertServerProfile({ serverUrl: 'https://conflict.example.test', name: 'Conflict' });
        const scope = { serverId: server.id, accountId: 'account' } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        setActiveServerId(server.id, { scope: 'tab' });
        storage.getState().activateProfileScope(scope);
        (await persist({ sessionId, localId, text: 'local content', scope, operation: 'enqueue' }));
        const encryption = await Encryption.create(new Uint8Array(32).fill(10));

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => response(localId, 'queued', 'server content'),
        });

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                source: 'server_pending',
                text: 'server content',
                pendingOutboxConflict: true,
            }),
        ]);
        expect((await loadPendingOutboxForSession(sessionId, scope))).toEqual([]);
        expect((await replayPersistedPendingOutboxForSession(sessionId, scope))).toEqual([]);
    });

    it('never replays retired conflicting custody after the server row disappears', async () => {
        const sessionId = 'conflicting-row-disappears-session';
        const localId = 'conflicting-row-disappears-local';
        const server = upsertServerProfile({ serverUrl: 'https://conflict-disappears.example.test', name: 'Conflict disappears' });
        const scope = { serverId: server.id, accountId: 'account' } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        (await persist({ sessionId, localId, text: 'retained local custody', scope, operation: 'enqueue' }));
        const encryption = await Encryption.create(new Uint8Array(32).fill(15));

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => response(localId, 'queued', 'conflicting server content'),
        });
        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({ pending: [] }),
        });

        expect((await loadPendingOutboxForSession(sessionId, scope))).toEqual([]);
        expect((await replayPersistedPendingOutboxForSession(sessionId, scope))).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([]);
    });

    it('lets an unprojectable same-ID server row retire enqueue custody with a failure projection', async () => {
        const sessionId = 'malformed-server-identity-session';
        const localId = 'malformed-server-identity-local';
        const server = upsertServerProfile({ serverUrl: 'https://malformed-row.example.test', name: 'Malformed row' });
        const scope = { serverId: server.id, accountId: 'account' } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        (await persist({ sessionId, localId, text: 'must not replay', scope, operation: 'enqueue' }));
        const encryption = await Encryption.create(new Uint8Array(32).fill(14));

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({
                pending: [{
                    localId,
                    content: { t: 'future-envelope', payload: 'opaque' },
                    requestedAction: { v: 1, kind: 'enqueue' },
                    status: 'queued',
                }],
            }),
        });

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                source: 'server_pending',
                pendingDecryptFailure: { kind: 'decrypt_failed' },
                pendingOutboxConflict: true,
            }),
        ]);
        expect((await loadPendingOutboxForSession(sessionId, scope))).toEqual([]);
        expect((await replayPersistedPendingOutboxForSession(sessionId, scope))).toEqual([]);
    });

    it('retires external-handoff enqueue custody when an ordinary server row owns the identity', async () => {
        const sessionId = 'delivery-mode-conflict-session';
        const localId = 'delivery-mode-conflict-local';
        const server = upsertServerProfile({ serverUrl: 'https://delivery-mode.example.test', name: 'Delivery mode' });
        const scope = { serverId: server.id, accountId: 'account' } as const;
        const rawRecord = { role: 'user', content: { type: 'text', text: 'same content' }, meta: {} } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        setActiveServerId(server.id, { scope: 'tab' });
        storage.getState().activateProfileScope(scope);
        (await savePendingOutboxMessage({
            sessionId,
            localId,
            createdAt: 111,
            text: 'same content',
            rawRecord,
            operation: 'enqueue',
            request: {
                v: 1,
                body: JSON.stringify({
                    localId,
                    content: { t: 'plain', v: rawRecord },
                    messageRole: 'user',
                    requestedAction: { v: 1, kind: 'enqueue' },
                    deliveryMode: 'external_handoff',
                }),
            },
        }, scope));
        (await replayPersistedPendingOutboxForSession(sessionId, scope));
        const encryption = await Encryption.create(new Uint8Array(32).fill(12));

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => response(localId, 'queued', 'same content'),
        });

        expect(storage.getState().sessionPending[sessionId]?.messages[0]).toMatchObject({
            source: 'server_pending',
            text: 'same content',
        });
        expect((await loadPendingOutboxForSession(sessionId, scope))).toEqual([]);
        expect((await replayPersistedPendingOutboxForSession(sessionId, scope))).toEqual([]);
    });

    it('retires ordinary enqueue custody when an external-handoff server row owns the identity', async () => {
        const sessionId = 'ordinary-external-conflict-session';
        const localId = 'ordinary-external-conflict-local';
        const server = upsertServerProfile({ serverUrl: 'https://ordinary-external.example.test', name: 'Ordinary external' });
        const scope = { serverId: server.id, accountId: 'account' } as const;
        const text = 'same content';
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        setActiveServerId(server.id, { scope: 'tab' });
        storage.getState().activateProfileScope(scope);
        (await persist({ sessionId, localId, text, scope, operation: 'enqueue' }));
        const encryption = await Encryption.create(new Uint8Array(32).fill(13));

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({
                pending: [{
                    localId,
                    messageRole: 'user',
                    content: {
                        t: 'plain',
                        v: { role: 'user', content: { type: 'text', text }, meta: {} },
                    },
                    requestedAction: { v: 1, kind: 'enqueue' },
                    status: 'queued',
                    deliveryState: 'external_handoff',
                    deliveryStatus: { status: 'external_handoff' },
                    position: 0,
                    createdAt: 222,
                    updatedAt: 223,
                    discardedAt: null,
                    discardedReason: null,
                }],
            }),
        });

        expect(storage.getState().sessionPending[sessionId]?.messages[0]).toMatchObject({
            source: 'server_pending',
            pendingDeliveryStatus: 'external_handoff',
            text,
        });
        expect((await loadPendingOutboxForSession(sessionId, scope))).toEqual([]);
        expect((await replayPersistedPendingOutboxForSession(sessionId, scope))).toEqual([]);
    });

    it('retires exact retry custody when the server owns a conflicting ciphertext envelope', async () => {
        const sessionId = 'ciphertext-conflict-session';
        const localId = 'ciphertext-conflict-local';
        const server = upsertServerProfile({ serverUrl: 'https://ciphertext.example.test', name: 'Ciphertext' });
        const scope = { serverId: server.id, accountId: 'account' } as const;
        const rawRecord = { role: 'user', content: { type: 'text', text: 'same decrypted content' }, meta: {} } as const;
        const localCiphertext = 'local-frozen-ciphertext';
        const serverCiphertext = 'server-frozen-ciphertext';
        const encryption = {
            getSessionEncryption: () => ({
                decryptRaw: async (payload: string) => payload === serverCiphertext ? rawRecord : null,
            }),
        };
        storage.getState().applySessions([buildSession({ sessionId })]);
        setActiveServerId(server.id, { scope: 'tab' });
        storage.getState().activateProfileScope(scope);
        (await savePendingOutboxMessage({
            sessionId,
            localId,
            createdAt: 111,
            text: 'same decrypted content',
            rawRecord,
            operation: 'enqueue',
            request: {
                v: 1,
                body: JSON.stringify({
                    localId,
                    ciphertext: localCiphertext,
                    messageRole: 'user',
                    requestedAction: { v: 1, kind: 'enqueue' },
                }),
            },
        }, scope));
        (await replayPersistedPendingOutboxForSession(sessionId, scope));

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({
                pending: [{
                    localId,
                    messageRole: 'user',
                    content: { t: 'encrypted', c: serverCiphertext },
                    requestedAction: { v: 1, kind: 'enqueue' },
                    status: 'queued',
                    position: 0,
                    createdAt: 222,
                    updatedAt: 223,
                    discardedAt: null,
                    discardedReason: null,
                }],
            }),
        });

        expect(storage.getState().sessionPending[sessionId]?.messages[0]).toMatchObject({
            source: 'server_pending',
            text: 'same decrypted content',
        });
        expect((await loadPendingOutboxForSession(sessionId, scope))).toEqual([]);
        expect((await replayPersistedPendingOutboxForSession(sessionId, scope))).toEqual([]);
    });

    it('converges an ambiguous POST to the matching server snapshot without showing Message not sent', async () => {
        const sessionId = 'ambiguous-snapshot-session';
        const localId = 'ambiguous-snapshot-local';
        const server = upsertServerProfile({ serverUrl: 'https://ambiguous.example.test', name: 'Ambiguous' });
        const scope = { serverId: server.id, accountId: 'account' } as const;
        storage.getState().applySessions([{ ...buildSession({ sessionId }), encryptionMode: 'plain' }]);
        setActiveServerId(server.id, { scope: 'tab' });
        storage.getState().activateProfileScope(scope);
        (await persist({ sessionId, localId, text: 'committed despite response loss', scope, operation: 'enqueue' }));

        await expect(retryPendingOutboxOperationV2({
            sessionId,
            localId,
            outboxScope: scope,
            request: async () => { throw new ServerFetchWriteTimeoutError(); },
        })).resolves.toEqual({ accepted: false });
        expect(storage.getState().sessionPending[sessionId]?.messages[0]?.sendState).toBe('unconfirmed');

        const encryption = await Encryption.create(new Uint8Array(32).fill(11));
        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => response(localId, 'queued', 'committed despite response loss'),
        });

        const reconciled = storage.getState().sessionPending[sessionId]?.messages[0];
        expect(reconciled).toMatchObject({
            localId,
            source: 'server_pending',
            text: 'committed despite response loss',
        });
        expect(reconciled).not.toHaveProperty('sendState');
        expect(getPendingMessageVisualState(reconciled!)).toMatchObject({ kind: 'queued' });
    });
});
