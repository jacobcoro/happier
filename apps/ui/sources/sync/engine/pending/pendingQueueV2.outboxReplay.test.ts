import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { Platform } from 'react-native';

import { storage } from '@/sync/domains/state/storage';
import {
    findPendingOutboxMessage,
    loadPendingOutboxForSession,
    markPendingOutboxMessageCancelRequested,
    removePendingOutboxMessage,
    savePendingOutboxMessage,
} from '@/sync/domains/state/pendingOutboxPersistence';
import { getPersistenceStorage } from '@/sync/domains/state/persistence';
import { scopedSessionLocalStateKey } from '@/sync/domains/state/sessionLocalStateKeys';

import {
    deletePendingMessageV2,
    enqueuePendingMessageV2 as enqueuePendingMessageV2Impl,
    fetchAndApplyPendingMessagesV2,
    replayPersistedPendingOutboxForSession,
    restoreDiscardedPendingMessageV2,
    deleteDiscardedPendingMessageV2,
    retryPendingOutboxOperationV2 as retryPendingOutboxOperationV2Impl,
    setPendingMessageSendState,
    updatePendingRequestedActionV2 as updatePendingRequestedActionV2Impl,
} from './pendingQueueV2';
import {
    buildSession,
    createPendingQueueEncryption,
    resetPendingQueueState,
    withExactPendingEnqueueAckIdentityForTest,
} from './pendingQueueV2.testHelpers';

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

describe('pendingQueueV2 durable outbox', () => {
    const targetScope = { serverId: 'server-b', accountId: 'account-b' } as const;
    const otherScope = { serverId: 'server-b', accountId: 'account-a' } as const;
    const enqueuePendingMessageV2 = (
        params: Omit<Parameters<typeof enqueuePendingMessageV2Impl>[0], 'requestedAction' | 'wireMode'>
            & Partial<Pick<Parameters<typeof enqueuePendingMessageV2Impl>[0], 'requestedAction'>>,
    ) => enqueuePendingMessageV2Impl({
        ...params,
        request: withExactPendingEnqueueAckIdentityForTest(params.request),
        requestedAction: params.requestedAction ?? { v: 1, kind: 'enqueue' },
        wireMode: 'pending_input_v1',
    });

    beforeEach(() => {
        resetPendingQueueState();
    });

    it('does not send or release the composer when browser durable custody fails', async () => {
        const sessionId = 'browser-storage-failed';
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        const platform = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        vi.stubGlobal('indexedDB', new IDBFactory());
        const originalPut = IDBObjectStore.prototype.put;
        const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
            const request = originalPut.apply(this, args);
            this.transaction.abort();
            return request;
        });
        const request = vi.fn(async () => Response.json({}));
        const onLocalPendingProjectionCreated = vi.fn();
        try {
            await expect(enqueuePendingMessageV2({
                sessionId, localId: 'browser-custody', text: 'retain composer',
                encryption: { getSessionEncryption: () => null }, request,
                onLocalPendingProjectionCreated, outboxScope: targetScope,
            })).rejects.toThrow();
            expect(request).not.toHaveBeenCalled();
            expect(onLocalPendingProjectionCreated).not.toHaveBeenCalled();
            expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
            expect(storage.getState().sessions[sessionId]?.optimisticThinkingAt).toBeNull();
        } finally {
            put.mockRestore();
            Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
            vi.unstubAllGlobals();
        }
    });

    it('replays a retained pre-action envelope unchanged and accepts the server enqueue translation', async () => {
        const sessionId = 's_outbox_legacy_omission';
        const localId = 'legacy-omitted-action';
        const body = JSON.stringify({
            localId,
            messageRole: 'user',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'retained' }, meta: {} } },
        });
        (await savePendingOutboxMessage({
            sessionId,
            localId,
            createdAt: 42,
            text: 'retained',
            rawRecord: { role: 'user', content: { type: 'text', text: 'retained' }, meta: {} },
            request: { v: 1, body },
        }, targetScope));
        const sentBodies: string[] = [];

        await expect(retryPendingOutboxOperationV2({
            sessionId,
            localId,
            outboxScope: targetScope,
            request: async (_path, init) => {
                sentBodies.push(String(init?.body ?? ''));
                return new Response(JSON.stringify({ requestedAction: { v: 1, kind: 'enqueue' } }), { status: 200 });
            },
        })).resolves.toEqual({ accepted: true });

        expect(sentBodies).toEqual([body]);
    });

    it('write-aheads the outbox before the network call and clears it on confirmation', async () => {
        const sessionId = 's_outbox_ok';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 3 });

        let outboxDuringWrite: number | null = null;
        const result = await enqueuePendingMessageV2({
            sessionId,
            text: 'durable hello',
            encryption,
            outboxScope: targetScope,
            request: async () => {
                // At the moment of the write, the row must already be persisted (write-ahead).
                outboxDuringWrite = (await loadPendingOutboxForSession(sessionId, targetScope)).length;
                return Response.json({ requestedAction: { v: 1, kind: 'enqueue' } });
            },
        });

        expect(result.accepted).toBe(true);
        expect(outboxDuringWrite).toBe(1);
        // Confirmed => the durable outbox row is cleared so it is not replayed.
        expect((await loadPendingOutboxForSession(sessionId, targetScope))).toEqual([]);
    });

    it('retains the outbox row when the write hits transient connectivity and marks it unconfirmed', async () => {
        const sessionId = 's_outbox_transient';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 4 });

        const result = await enqueuePendingMessageV2({
            sessionId,
            text: 'stalled hello',
            encryption,
            outboxScope: targetScope,
            request: async () => {
                throw new TypeError('Failed to fetch');
            },
        });

        expect(result.accepted).toBe(false);
        expect((await loadPendingOutboxForSession(sessionId, targetScope))).toHaveLength(1);
        const row = storage.getState().sessionPending[sessionId]?.messages?.[0];
        expect(row?.sendState).toBe('unconfirmed');
    });

    it('retains a new exact enqueue as ambiguous when the request wrapper rejects after transport completion', async () => {
        const sessionId = 's_outbox_postflight_scope_initial';
        const localId = 'postflight-scope-initial';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 4 });
        let transportCompleted = false;

        await expect(enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'possibly committed before scope changed',
            encryption,
            outboxScope: targetScope,
            request: async () => {
                transportCompleted = true;
                throw new Error('Pending queue owner scope changed after transport');
            },
        })).resolves.toEqual({ localId, accepted: false });

        expect(transportCompleted).toBe(true);
        expect((await loadPendingOutboxForSession(sessionId, targetScope))).toEqual([
            expect.objectContaining({ localId, operation: 'enqueue' }),
        ]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                source: 'local_outbound',
                sendState: 'unconfirmed',
            }),
        ]);
    });

    it('keeps replay custody ambiguous when the request wrapper rejects after transport completion', async () => {
        const sessionId = 's_outbox_postflight_scope_replay';
        const localId = 'postflight-scope-replay';
        const body = JSON.stringify({
            localId,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'exact replay' }, meta: {} } },
            messageRole: 'user',
        });
        (await savePendingOutboxMessage({
            sessionId,
            localId,
            createdAt: 42,
            text: 'exact replay',
            rawRecord: { role: 'user', content: { type: 'text', text: 'exact replay' }, meta: {} },
            request: { v: 1, body },
        }, targetScope));
        (await replayPersistedPendingOutboxForSession(sessionId, targetScope));
        let transportCompleted = false;

        await expect(retryPendingOutboxOperationV2({
            sessionId,
            localId,
            outboxScope: targetScope,
            request: async () => {
                transportCompleted = true;
                throw new Error('Pending queue owner scope changed after transport');
            },
        })).rejects.toThrow('Pending queue owner scope changed after transport');

        expect(transportCompleted).toBe(true);
        expect((await loadPendingOutboxForSession(sessionId, targetScope))).toEqual([
            expect.objectContaining({ localId, operation: 'enqueue', request: { v: 1, body } }),
        ]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId, sendState: 'unconfirmed' }),
        ]);
    });


    it('replays a lost-ack external handoff as retained visible custody without dispatching it', async () => {
        const sessionId = 's_outbox_external_handoff_lost_ack';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 5 });

        const firstAttempt = await enqueuePendingMessageV2({
            sessionId,
            text: 'voice turn with a lost acknowledgement',
            encryption,
            deliveryMode: 'external_handoff',
            outboxScope: targetScope,
            request: async () => {
                throw new TypeError('Failed to fetch');
            },
        });

        expect(firstAttempt.accepted).toBe(false);
        expect((await loadPendingOutboxForSession(sessionId, targetScope))).toHaveLength(1);

        await retryPendingOutboxOperationV2({
            sessionId,
            localId: firstAttempt.localId,
            outboxScope: targetScope,
            request: async () => Response.json({
                requestedAction: { v: 1, kind: 'enqueue' },
                pending: { deliveryStatus: { status: 'external_handoff' } },
            }),
        });

        expect((await loadPendingOutboxForSession(sessionId, targetScope))).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages?.[0]).toMatchObject({
            localId: firstAttempt.localId,
            pendingDeliveryStatus: 'external_handoff',
        });
        expect(storage.getState().sessionPending[sessionId]?.messages?.[0]?.sendState).toBeUndefined();
    });

    it('cold-rejoins a valid external envelope with malformed auxiliary data through concurrent DELETE', async () => {
        const sessionId = 's_external_handoff_cold_rejoin_malformed_auxiliary';
        const localId = 'external-handoff-cold-rejoin-malformed-auxiliary';
        const frozenBody = JSON.stringify({
            localId,
            content: {
                t: 'plain',
                v: { role: 'user', content: { type: 'text', text: 'frozen external authority' }, meta: {} },
            },
            messageRole: 'user',
            requestedAction: { v: 1, kind: 'enqueue' },
            deliveryMode: 'external_handoff',
        });
        getPersistenceStorage().set(
            scopedSessionLocalStateKey('session-pending-outbox-v1', targetScope),
            JSON.stringify({
                [sessionId]: [{
                    localId,
                    createdAt: 42,
                    text: 'safe auxiliary display',
                    rawRecord: { role: 'user' },
                    operation: 'enqueue',
                    request: { v: 1, body: frozenBody },
                }],
            }),
        );
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
        expect((await loadPendingOutboxForSession(sessionId, targetScope))).toEqual([
            expect.objectContaining({ localId, operation: 'enqueue', request: { v: 1, body: frozenBody } }),
        ]);
        let releasePost!: () => void;
        const postGate = new Promise<void>((resolve) => { releasePost = resolve; });
        let postStarted!: () => void;
        const postStartedGate = new Promise<void>((resolve) => { postStarted = resolve; });
        const sentBodies: string[] = [];
        const methods: string[] = [];
        const request = async (_path: string, init?: RequestInit): Promise<Response> => {
            const method = init?.method ?? 'GET';
            methods.push(method);
            if (method === 'POST') {
                sentBodies.push(String(init?.body ?? ''));
                postStarted();
                await postGate;
                return Response.json({
                    requestedAction: { v: 1, kind: 'enqueue' },
                    pending: { deliveryStatus: { status: 'external_handoff' } },
                });
            }
            return new Response(null, { status: 204 });
        };

        const retry = retryPendingOutboxOperationV2({ sessionId, localId, outboxScope: targetScope, request });
        await postStartedGate;
        const deletion = deletePendingMessageV2({ sessionId, pendingId: localId, outboxScope: targetScope, request });
        releasePost();
        await expect(Promise.all([retry, deletion])).resolves.toEqual([{ accepted: true }, undefined]);

        expect(methods).toEqual(['POST', 'DELETE']);
        expect(sentBodies).toEqual([frozenBody]);
        expect((await loadPendingOutboxForSession(sessionId, targetScope))).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                pendingDeliveryStatus: 'external_handoff',
            }),
        ]);
        expect(storage.getState().sessionPending[sessionId]?.messages[0]?.pendingOutboxQuarantineReason).toBeUndefined();
    });

    it('keeps cold external custody separate from a same-localId server row in another scope', async () => {
        const sessionId = 's_external_handoff_cold_rejoin_other_scope';
        const localId = 'external-handoff-cold-rejoin-other-scope';
        const otherServerProjectionId = 'other-scope-server-projection';
        const frozenBody = JSON.stringify({
            localId,
            content: {
                t: 'plain',
                v: { role: 'user', content: { type: 'text', text: 'target frozen authority' }, meta: {} },
            },
            messageRole: 'user',
            requestedAction: { v: 1, kind: 'enqueue' },
            deliveryMode: 'external_handoff',
        });
        getPersistenceStorage().set(
            scopedSessionLocalStateKey('session-pending-outbox-v1', targetScope),
            JSON.stringify({
                [sessionId]: [{
                    localId,
                    createdAt: 42,
                    text: 'target safe diagnostic',
                    rawRecord: { role: 'user' },
                    operation: 'enqueue',
                    request: { v: 1, body: frozenBody },
                }],
            }),
        );
        storage.getState().upsertPendingMessage(sessionId, {
            id: otherServerProjectionId,
            localId,
            createdAt: 1,
            updatedAt: 1,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'server_queued',
            pendingOutboxScope: otherScope,
            text: 'other scope authority',
            rawRecord: { role: 'user', content: { type: 'text', text: 'other scope authority' }, meta: {} },
        });

        await expect(retryPendingOutboxOperationV2({
            sessionId,
            localId,
            outboxScope: targetScope,
            request: async (_path, init) => {
                expect(String(init?.body ?? '')).toBe(frozenBody);
                return Response.json({
                    requestedAction: { v: 1, kind: 'enqueue' },
                    pending: { deliveryStatus: { status: 'external_handoff' } },
                });
            },
        })).resolves.toEqual({ accepted: true });

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                id: otherServerProjectionId,
                pendingOutboxScope: otherScope,
                pendingDeliveryStatus: 'server_queued',
                text: 'other scope authority',
            }),
            expect.objectContaining({
                localId,
                pendingOutboxScope: targetScope,
                pendingDeliveryStatus: 'external_handoff',
                text: 'target safe diagnostic',
            }),
        ]);
    });

    it('directly cold-rejoins malformed auxiliary external custody beside another-scope authority', async () => {
        const sessionId = 's_external_handoff_direct_cold_rejoin_other_scope';
        const localId = 'external-handoff-direct-cold-rejoin-other-scope';
        const frozenBody = JSON.stringify({
            localId,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'direct frozen authority' }, meta: {} } },
            messageRole: 'user',
            requestedAction: { v: 1, kind: 'enqueue' },
            deliveryMode: 'external_handoff',
        });
        storage.getState().applySessions([buildSession({ sessionId })]);
        getPersistenceStorage().set(
            scopedSessionLocalStateKey('session-pending-outbox-v1', targetScope),
            JSON.stringify({
                [sessionId]: [{
                    localId,
                    createdAt: 42,
                    text: 'direct safe diagnostic',
                    rawRecord: { role: 'user' },
                    operation: 'enqueue',
                    request: { v: 1, body: frozenBody },
                }],
            }),
        );
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'direct-other-scope-authority',
            localId,
            createdAt: 1,
            updatedAt: 1,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'server_queued',
            pendingOutboxScope: otherScope,
            text: 'other scope remains',
            rawRecord: { role: 'user', content: { type: 'text', text: 'other scope remains' }, meta: {} },
        });
        const sentBodies: string[] = [];

        await expect(enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'caller text is not authority',
            encryption: await createPendingQueueEncryption({ sessionId }),
            outboxScope: targetScope,
            request: async (_path, init) => {
                sentBodies.push(String(init?.body ?? ''));
                return Response.json({
                    requestedAction: { v: 1, kind: 'enqueue' },
                    pending: { deliveryStatus: { status: 'external_handoff' } },
                });
            },
        })).resolves.toEqual(expect.objectContaining({ localId, accepted: true, externalHandoffClaimed: true }));

        expect(sentBodies).toEqual([frozenBody]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                id: 'direct-other-scope-authority',
                pendingOutboxScope: otherScope,
                pendingDeliveryStatus: 'server_queued',
            }),
            expect.objectContaining({
                localId,
                pendingOutboxScope: targetScope,
                pendingDeliveryStatus: 'external_handoff',
            }),
        ]);
        expect(storage.getState().sessionPending[sessionId]?.messages.find((message) =>
            message.pendingOutboxScope === targetScope
        )?.pendingOutboxQuarantineReason).toBeUndefined();
    });

    it('re-hydrates a persisted outbox row that is absent from the in-memory slice', async () => {
        const sessionId = 's_outbox_replay';
        (await savePendingOutboxMessage({
            sessionId,
            localId: 'orphan-1',
            createdAt: 42,
            text: 'survived an app kill',
            rawRecord: { role: 'user', content: { type: 'text', text: 'survived an app kill' } },
            request: {
                v: 1,
                body: '{"localId":"orphan-1","content":{"t":"plain","v":{}},"messageRole":"user"}',
            },
        }, targetScope));

        const localIds = (await replayPersistedPendingOutboxForSession(sessionId, targetScope));
        expect(localIds).toEqual(['orphan-1']);

        const rows = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            localId: 'orphan-1',
            source: 'local_outbound',
            sendState: 'unconfirmed',
            text: 'survived an app kill',
        });
    });

    it('does not auto-rearm failed same-scope custody on replay but permits explicit retry', async () => {
        const sessionId = 's_outbox_failed_replay';
        const localId = 'failed-replay-1';
        const rawRecord = {
            role: 'user' as const,
            content: { type: 'text' as const, text: 'retry only when asked' },
            meta: {},
        };
        (await savePendingOutboxMessage({
            sessionId,
            localId,
            createdAt: 42,
            text: 'retry only when asked',
            rawRecord,
            request: {
                v: 1,
                body: JSON.stringify({
                    localId,
                    content: { t: 'plain', v: rawRecord },
                    messageRole: 'user',
                }),
            },
        }, targetScope));

        expect((await replayPersistedPendingOutboxForSession(sessionId, targetScope))).toEqual([localId]);
        (await setPendingMessageSendState(sessionId, localId, 'failed', targetScope));

        expect((await replayPersistedPendingOutboxForSession(sessionId, targetScope))).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId, sendState: 'failed', pendingOutboxScope: targetScope }),
        ]);

        (await setPendingMessageSendState(sessionId, localId, 'unconfirmed', targetScope));
        const requests: string[] = [];
        await expect(retryPendingOutboxOperationV2({
            sessionId,
            localId,
            outboxScope: targetScope,
            request: async (path) => {
                requests.push(path);
                return Response.json({ requestedAction: { v: 1, kind: 'enqueue' } });
            },
        })).resolves.toEqual({ accepted: true });

        expect(requests).toEqual([`/v2/sessions/${sessionId}/pending`]);
        expect((await loadPendingOutboxForSession(sessionId, targetScope))).toEqual([]);
    });

    it('allocates normal replay projections without overwriting canonical or cross-scope IDs', async () => {
        const sessionId = 's_normal_projection_id_reservations';
        const crossScopeLocalId = 'cross-scope-reserved-id';
        const canonicalReservedId = 'canonical-reserved-id';
        const save = async (localId: string) => (await savePendingOutboxMessage({
            sessionId,
            localId,
            createdAt: 42,
            text: `target ${localId}`,
            rawRecord: { role: 'user', content: { type: 'text', text: `target ${localId}` }, meta: {} },
            request: { v: 1, body: JSON.stringify({ localId, content: { t: 'plain', v: {} }, messageRole: 'user' }) },
        }, targetScope));
        (await save(crossScopeLocalId));
        (await save(canonicalReservedId));
        storage.getState().upsertPendingMessage(sessionId, {
            id: crossScopeLocalId,
            localId: crossScopeLocalId,
            createdAt: 1,
            updatedAt: 1,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'server_queued',
            pendingOutboxScope: otherScope,
            text: 'cross scope reserved',
            rawRecord: { role: 'user', content: { type: 'text', text: 'cross scope reserved' }, meta: {} },
        });
        storage.getState().upsertPendingMessage(sessionId, {
            id: canonicalReservedId,
            localId: 'different-canonical-local-id',
            createdAt: 2,
            updatedAt: 2,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'server_queued',
            text: 'canonical reserved',
            rawRecord: { role: 'user', content: { type: 'text', text: 'canonical reserved' }, meta: {} },
        });

        expect((await replayPersistedPendingOutboxForSession(sessionId, targetScope))).toEqual([
            crossScopeLocalId,
            canonicalReservedId,
        ]);
        const messages = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(messages).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: crossScopeLocalId, source: 'server_pending', pendingOutboxScope: otherScope, text: 'cross scope reserved' }),
            expect.objectContaining({ id: canonicalReservedId, source: 'server_pending', text: 'canonical reserved' }),
            expect.objectContaining({ localId: crossScopeLocalId, pendingOutboxScope: targetScope, text: `target ${crossScopeLocalId}` }),
            expect.objectContaining({ localId: canonicalReservedId, pendingOutboxScope: targetScope, text: `target ${canonicalReservedId}` }),
        ]));
        expect(messages.find((message) => message.pendingOutboxScope === targetScope && message.localId === crossScopeLocalId)?.id)
            .not.toBe(crossScopeLocalId);
        expect(messages.find((message) => message.pendingOutboxScope === targetScope && message.localId === canonicalReservedId)?.id)
            .not.toBe(canonicalReservedId);
    });

    it('allocates brand-new enqueue projections around active and discarded occupied IDs', async () => {
        const sessionId = 's_new_enqueue_projection_id_reservations';
        const activeReservedId = 'new-enqueue-active-reserved';
        const discardedReservedId = 'new-enqueue-discarded-reserved';
        storage.getState().applySessions([buildSession({ sessionId })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: activeReservedId,
            localId: 'unrelated-active-local',
            createdAt: 1,
            updatedAt: 1,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'server_queued',
            text: 'active reserved',
            rawRecord: { role: 'user', content: { type: 'text', text: 'active reserved' }, meta: {} },
        });
        storage.getState().applyPendingSnapshot(sessionId, {
            messages: storage.getState().sessionPending[sessionId]!.messages,
            discarded: [{
                id: discardedReservedId,
                localId: 'unrelated-discarded-local',
                createdAt: 2,
                updatedAt: 2,
                source: 'server_pending',
                deliveryStatus: 'accepted',
                text: 'discarded reserved',
                rawRecord: { role: 'user', content: { type: 'text', text: 'discarded reserved' }, meta: {} },
                discardedAt: 3,
                discardedReason: 'manual',
            }],
        });
        const enqueue = async (localId: string) => enqueuePendingMessageV2({
            sessionId,
            localId,
            text: `target ${localId}`,
            encryption: await createPendingQueueEncryption({ sessionId }),
            outboxScope: targetScope,
            request: async () => {
                throw new TypeError('Failed to fetch');
            },
        });

        await expect(enqueue(activeReservedId)).resolves.toEqual(expect.objectContaining({ accepted: false }));
        await expect(enqueue(discardedReservedId)).resolves.toEqual(expect.objectContaining({ accepted: false }));

        const messages = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(messages).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: activeReservedId, source: 'server_pending', text: 'active reserved' }),
            expect.objectContaining({ localId: activeReservedId, pendingOutboxScope: targetScope, text: `target ${activeReservedId}` }),
            expect.objectContaining({ localId: discardedReservedId, pendingOutboxScope: targetScope, text: `target ${discardedReservedId}` }),
        ]));
        expect(messages.find((message) => message.localId === activeReservedId && message.pendingOutboxScope === targetScope)?.id)
            .not.toBe(activeReservedId);
        expect(messages.find((message) => message.localId === discardedReservedId && message.pendingOutboxScope === targetScope)?.id)
            .not.toBe(discardedReservedId);
        expect(storage.getState().sessionPending[sessionId]?.discarded).toEqual([
            expect.objectContaining({ id: discardedReservedId, text: 'discarded reserved' }),
        ]);
    });

    it('reallocates durable normal projections when refresh claims their preferred IDs', async () => {
        const sessionId = 's_refresh_reallocates_normal_projection_ids';
        const localIds = ['refresh-target-pending', 'refresh-target-discarded'] as const;
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        for (const localId of localIds) {
            (await savePendingOutboxMessage({
                sessionId,
                localId,
                createdAt: 42,
                text: localId,
                rawRecord: { role: 'user', content: { type: 'text', text: localId }, meta: {} },
                request: { v: 1, body: JSON.stringify({ localId, content: { t: 'plain', v: {} }, messageRole: 'user' }) },
            }, targetScope));
            storage.getState().upsertPendingMessage(sessionId, {
                id: localId,
                localId: `other-${localId}`,
                createdAt: 1,
                updatedAt: 1,
                source: 'server_pending',
                deliveryStatus: 'accepted',
                pendingDeliveryStatus: 'server_queued',
                pendingOutboxScope: otherScope,
                text: `reserve ${localId}`,
                rawRecord: { role: 'user', content: { type: 'text', text: `reserve ${localId}` }, meta: {} },
            });
        }
        (await replayPersistedPendingOutboxForSession(sessionId, targetScope));
        const preferredIds = localIds.map((localId) => storage.getState().sessionPending[sessionId]?.messages.find((message) =>
            message.localId === localId && message.pendingOutboxScope === targetScope
        )!.id);
        const serverRow = (localId: string, status: 'queued' | 'discarded') => ({
            localId,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: `server ${status}` }, meta: {} } },
            requestedAction: { v: 1, kind: 'enqueue' },
            status,
            position: 0,
            createdAt: 2,
            updatedAt: 3,
            discardedAt: status === 'discarded' ? 3 : null,
            discardedReason: status === 'discarded' ? 'manual' : null,
        });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: await createPendingQueueEncryption({ sessionId }),
            outboxScope: targetScope,
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({
                pending: [serverRow(preferredIds[0], 'queued'), serverRow(preferredIds[1], 'discarded')],
            }),
        });

        const messages = storage.getState().sessionPending[sessionId]?.messages ?? [];
        for (const [index, localId] of localIds.entries()) {
            const durableProjection = messages.find((message) =>
                message.localId === localId && message.pendingOutboxScope === targetScope
            );
            expect(durableProjection).toBeDefined();
            expect(durableProjection?.id).not.toBe(preferredIds[index]);
        }
        expect(messages).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: preferredIds[0], source: 'server_pending' }),
        ]));
        expect(storage.getState().sessionPending[sessionId]?.discarded).toEqual([
            expect.objectContaining({ id: preferredIds[1], source: 'server_pending' }),
        ]);
    });

    it('persists and replays whitespace-distinct opaque local ids as separate rows', async () => {
        const sessionId = 's_outbox_opaque_ids';
        const localIds = [' request-1', 'request-1 '] as const;
        for (const localId of localIds) {
            (await savePendingOutboxMessage({
                sessionId,
                localId,
                createdAt: 42,
                text: localId,
                rawRecord: { role: 'user', content: { type: 'text', text: localId } },
                request: {
                    v: 1,
                    body: JSON.stringify({
                        localId,
                        content: { t: 'plain', v: {} },
                        messageRole: 'user',
                    }),
                },
            }, targetScope));
        }

        expect((await loadPendingOutboxForSession(sessionId, targetScope)).map((row) => row.localId)).toEqual(localIds);
        expect((await replayPersistedPendingOutboxForSession(sessionId, targetScope))).toEqual(localIds);
        expect(storage.getState().sessionPending[sessionId]?.messages.map((message) => message.localId)).toEqual(localIds);
    });

    it('isolates persisted enqueue envelopes by exact server-account scope', async () => {
        (await savePendingOutboxMessage({
            sessionId: 's_scoped',
            localId: 'scoped-local',
            createdAt: 42,
            text: 'scoped prompt',
            rawRecord: { role: 'user', content: { type: 'text', text: 'scoped prompt' } },
            request: {
                v: 1,
                body: '{"localId":"scoped-local","content":{"t":"plain","v":{}},"messageRole":"user"}',
            },
        }, targetScope));

        expect((await loadPendingOutboxForSession('s_scoped', targetScope))).toEqual([
            expect.objectContaining({
                localId: 'scoped-local',
                request: { v: 1, body: expect.any(String) },
            }),
        ]);
        expect((await loadPendingOutboxForSession('s_scoped', otherScope))).toEqual([]);
    });


    it('replays identical ids independently after a server-account switch for enqueue and cancel', async () => {
        const sessionId = 's_scope_switch_same_ids';
        const localId = 'same-local-id';
        const scopeA = { serverId: 'server-a', accountId: 'account-a' } as const;
        const scopeB = { serverId: 'server-b', accountId: 'account-b' } as const;
        const bodyA = JSON.stringify({ localId, content: { t: 'plain', v: { scope: 'A' } }, messageRole: 'user' });
        const bodyB = JSON.stringify({ localId, content: { t: 'plain', v: { scope: 'B' } }, messageRole: 'user' });
        const save = async (scope: typeof scopeA | typeof scopeB, text: string, body: string, operation: 'enqueue' | 'cancel') => {
            (await savePendingOutboxMessage({
                sessionId,
                localId,
                createdAt: 42,
                text,
                operation,
                rawRecord: { role: 'user', content: { type: 'text', text }, meta: {} },
                request: { v: 1, body },
            }, scope));
        };
        (await save(scopeA, 'A', bodyA, 'enqueue'));
        (await save(scopeB, 'B', bodyB, 'enqueue'));

        expect((await replayPersistedPendingOutboxForSession(sessionId, scopeA))).toEqual([localId]);
        expect((await replayPersistedPendingOutboxForSession(sessionId, scopeB))).toEqual([localId]);
        const callsA: Array<{ method?: string; body?: string }> = [];
        const callsB: Array<{ method?: string; body?: string }> = [];
        const requestFor = (calls: Array<{ method?: string; body?: string }>) => async (_path: string, init?: RequestInit) => {
            calls.push({ method: init?.method, body: typeof init?.body === 'string' ? init.body : undefined });
            return Response.json({ requestedAction: { v: 1, kind: 'enqueue' } });
        };
        await retryPendingOutboxOperationV2({ sessionId, localId, outboxScope: scopeA, request: requestFor(callsA) });
        await retryPendingOutboxOperationV2({ sessionId, localId, outboxScope: scopeB, request: requestFor(callsB) });
        expect(callsA).toEqual([{ method: 'POST', body: bodyA }]);
        expect(callsB).toEqual([{ method: 'POST', body: bodyB }]);

        (await save(scopeA, 'A', bodyA, 'cancel'));
        (await save(scopeB, 'B', bodyB, 'cancel'));
        (await replayPersistedPendingOutboxForSession(sessionId, scopeA));
        (await replayPersistedPendingOutboxForSession(sessionId, scopeB));
        await retryPendingOutboxOperationV2({ sessionId, localId, outboxScope: scopeA, request: requestFor(callsA) });
        await retryPendingOutboxOperationV2({ sessionId, localId, outboxScope: scopeB, request: requestFor(callsB) });
        expect(callsA).toEqual([{ method: 'POST', body: bodyA }, { method: 'DELETE', body: undefined }]);
        expect(callsB).toEqual([{ method: 'POST', body: bodyB }, { method: 'DELETE', body: undefined }]);
    });

    it('does not replace the current scope projection when another scope retry is accepted', async () => {
        const sessionId = 's_scope_switch_retry_projection';
        const localId = 'same-retry-id';
        const scopeA = { serverId: 'server-a', accountId: 'account-a' } as const;
        const scopeB = { serverId: 'server-b', accountId: 'account-b' } as const;
        const save = async (scope: typeof scopeA | typeof scopeB, text: string) => (await savePendingOutboxMessage({
            sessionId,
            localId,
            createdAt: 42,
            text,
            rawRecord: { role: 'user', content: { type: 'text', text }, meta: {} },
            request: { v: 1, body: JSON.stringify({ localId, content: { t: 'plain', v: { text } }, messageRole: 'user' }) },
        }, scope));
        (await save(scopeA, 'A'));
        (await replayPersistedPendingOutboxForSession(sessionId, scopeA));
        let postStarted!: () => void;
        const postStartedGate = new Promise<void>((resolve) => { postStarted = resolve; });
        let releasePost!: () => void;
        const postGate = new Promise<void>((resolve) => { releasePost = resolve; });
        const retryA = retryPendingOutboxOperationV2({
            sessionId,
            localId,
            outboxScope: scopeA,
            request: async () => {
                postStarted();
                await postGate;
                return Response.json({ requestedAction: { v: 1, kind: 'enqueue' } });
            },
        });
        await postStartedGate;

        (await save(scopeB, 'B'));
        (await replayPersistedPendingOutboxForSession(sessionId, scopeB));
        releasePost();
        await retryA;

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual(expect.arrayContaining([
            expect.objectContaining({ localId, text: 'A', pendingOutboxScope: scopeA }),
            expect.objectContaining({ localId, text: 'B', pendingOutboxScope: scopeB }),
        ]));
        expect(storage.getState().sessionPending[sessionId]?.messages).toHaveLength(2);
        expect((await loadPendingOutboxForSession(sessionId, scopeB))).toEqual([
            expect.objectContaining({ localId, text: 'B' }),
        ]);
    });

    it('treats a captured enqueue row that vanishes while queued as already settled', async () => {
        const sessionId = 's_outbox_vanished_while_queued';
        const blockerLocalId = 'blocker';
        const localId = 'already-settled';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const save = async (candidateLocalId: string) => (await savePendingOutboxMessage({
            sessionId,
            localId: candidateLocalId,
            createdAt: 42,
            text: candidateLocalId,
            rawRecord: { role: 'user', content: { type: 'text', text: candidateLocalId }, meta: {} },
            request: { v: 1, body: JSON.stringify({ localId: candidateLocalId, content: { t: 'plain', v: {} }, messageRole: 'user' }) },
        }, targetScope));
        (await save(blockerLocalId));
        (await save(localId));
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId,
            localId,
            createdAt: 41,
            updatedAt: 41,
            source: 'local_outbound',
            deliveryStatus: 'queued',
            pendingOutboxScope: targetScope,
            pendingOutboxOperation: 'enqueue',
            text: 'exact local must settle',
            rawRecord: { role: 'user', content: { type: 'text', text: 'exact local must settle' }, meta: {} },
        });
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'ordinary-authoritative', localId, createdAt: 42, updatedAt: 42,
            source: 'server_pending', deliveryStatus: 'accepted', pendingDeliveryStatus: 'server_queued',
            text: 'ordinary', rawRecord: { role: 'user', content: { type: 'text', text: 'ordinary' }, meta: {} },
        });
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'external-authoritative', localId, createdAt: 43, updatedAt: 43,
            source: 'server_pending', deliveryStatus: 'accepted', pendingDeliveryStatus: 'external_handoff',
            text: 'external', rawRecord: { role: 'user', content: { type: 'text', text: 'external' }, meta: {} },
        });
        let releaseBlocker!: () => void;
        const blockerGate = new Promise<void>((resolve) => { releaseBlocker = resolve; });
        let blockerStarted!: () => void;
        const blockerStartedGate = new Promise<void>((resolve) => { blockerStarted = resolve; });
        const blocker = retryPendingOutboxOperationV2({
            sessionId,
            localId: blockerLocalId,
            outboxScope: targetScope,
            request: async () => {
                blockerStarted();
                await blockerGate;
                return Response.json({ requestedAction: { v: 1, kind: 'enqueue' } });
            },
        });
        await blockerStartedGate;
        let targetRequestCalled = false;
        const target = retryPendingOutboxOperationV2({
            sessionId,
            localId,
            outboxScope: targetScope,
            request: async () => {
                targetRequestCalled = true;
                return Response.json({ requestedAction: { v: 1, kind: 'enqueue' } });
            },
        });
        (await removePendingOutboxMessage(sessionId, localId, targetScope));
        releaseBlocker();

        await expect(Promise.all([blocker, target])).resolves.toEqual([{ accepted: true }, { accepted: true }]);
        expect(targetRequestCalled).toBe(false);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ id: 'ordinary-authoritative' }),
            expect.objectContaining({ id: 'external-authoritative' }),
        ]);
    });

    it('does not let direct rejoin fall back to a captured row that vanished while queued', async () => {
        const sessionId = 's_outbox_direct_rejoin_vanished';
        const blockerLocalId = 'direct-blocker';
        const localId = 'direct-settled';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const save = async (candidateLocalId: string) => (await savePendingOutboxMessage({
            sessionId,
            localId: candidateLocalId,
            createdAt: 42,
            text: candidateLocalId,
            rawRecord: { role: 'user', content: { type: 'text', text: candidateLocalId }, meta: {} },
            request: { v: 1, body: JSON.stringify({ localId: candidateLocalId, content: { t: 'plain', v: {} }, messageRole: 'user' }) },
        }, targetScope));
        (await save(blockerLocalId));
        (await save(localId));
        let releaseBlocker!: () => void;
        const blockerGate = new Promise<void>((resolve) => { releaseBlocker = resolve; });
        let blockerStarted!: () => void;
        const blockerStartedGate = new Promise<void>((resolve) => { blockerStarted = resolve; });
        const blocker = retryPendingOutboxOperationV2({
            sessionId,
            localId: blockerLocalId,
            outboxScope: targetScope,
            request: async () => {
                blockerStarted();
                await blockerGate;
                return Response.json({ requestedAction: { v: 1, kind: 'enqueue' } });
            },
        });
        await blockerStartedGate;
        let targetRequestCalled = false;
        const directRejoin = enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'ignored replacement',
            encryption: await createPendingQueueEncryption({ sessionId }),
            outboxScope: targetScope,
            request: async () => {
                targetRequestCalled = true;
                return Response.json({ requestedAction: { v: 1, kind: 'enqueue' } });
            },
        });
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'other-scope-local-projection',
            localId,
            createdAt: 43,
            updatedAt: 43,
            source: 'local_outbound',
            deliveryStatus: 'queued',
            pendingOutboxScope: otherScope,
            pendingOutboxOperation: 'enqueue',
            text: 'other scope remains',
            rawRecord: { role: 'user', content: { type: 'text', text: 'other scope remains' }, meta: {} },
        });
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'exact-scope-canonical-projection',
            localId,
            createdAt: 44,
            updatedAt: 44,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'server_queued',
            pendingOutboxScope: targetScope,
            text: 'canonical remains',
            rawRecord: { role: 'user', content: { type: 'text', text: 'canonical remains' }, meta: {} },
        });
        (await removePendingOutboxMessage(sessionId, localId, targetScope));
        releaseBlocker();

        await expect(Promise.all([blocker, directRejoin])).resolves.toEqual([
            { accepted: true },
            { localId, accepted: true, settled: true },
        ]);
        expect(targetRequestCalled).toBe(false);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                id: 'other-scope-local-projection',
                pendingOutboxScope: otherScope,
                text: 'other scope remains',
            }),
            expect.objectContaining({
                id: 'exact-scope-canonical-projection',
                source: 'server_pending',
                pendingOutboxScope: targetScope,
                text: 'canonical remains',
            }),
        ]);
    });

    it('keeps unsupported persisted requested actions visible and terminal without transport', async () => {
        const sessionId = 's_outbox_unsupported_action';
        const localId = 'unsupported-action';
        storage.getState().applySessions([buildSession({ sessionId })]);
        (await savePendingOutboxMessage({
            sessionId,
            localId,
            createdAt: 42,
            text: 'future action stays visible',
            rawRecord: { role: 'user', content: { type: 'text', text: 'future action stays visible' }, meta: {} },
            request: {
                v: 1,
                body: JSON.stringify({
                    localId,
                    content: { t: 'plain', v: {} },
                    messageRole: 'user',
                    requestedAction: { v: 1, kind: 'future_action' },
                }),
            },
        }, targetScope));
        (await replayPersistedPendingOutboxForSession(sessionId, targetScope));
        const request = async (): Promise<Response> => {
            throw new Error('unsupported work must not reach provider transport');
        };

        await expect(retryPendingOutboxOperationV2({ sessionId, localId, outboxScope: targetScope, request }))
            .resolves.toEqual({ accepted: false, terminal: true });
        await expect(retryPendingOutboxOperationV2({ sessionId, localId, outboxScope: targetScope, request }))
            .resolves.toEqual({ accepted: false, terminal: true });

        expect((await loadPendingOutboxForSession(sessionId, targetScope))).toEqual([
            expect.objectContaining({ localId }),
        ]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                requestedActionMalformed: true,
                pendingDeliveryStatus: 'blocked',
                pendingDeliveryBlockedReason: 'unsupported_action',
            }),
        ]);
    });

    it('rejects dot IDs before replay transport', async () => {
        let requestCalled = false;
        await expect(retryPendingOutboxOperationV2({
            sessionId: 's_dot_replay',
            localId: '.',
            outboxScope: targetScope,
            request: async () => {
                requestCalled = true;
                return Response.json({});
            },
        })).rejects.toThrow('Pending message ID cannot be a dot path segment');
        expect(requestCalled).toBe(false);
    });

    it('preserves confirmed external-handoff custody when cancel races the initial POST acknowledgement', async () => {
        const sessionId = 's_external_handoff_cancel_races_initial_ack';
        const localId = 'external-handoff-cancel-races-initial-ack';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 5 });
        let releasePost!: () => void;
        const postGate = new Promise<void>((resolve) => { releasePost = resolve; });
        let postStarted!: () => void;
        const postStartedGate = new Promise<void>((resolve) => { postStarted = resolve; });
        const methods: string[] = [];
        const request = async (_path: string, init?: RequestInit): Promise<Response> => {
            const method = init?.method ?? 'GET';
            methods.push(method);
            if (method === 'POST') {
                postStarted();
                await postGate;
                return Response.json({
                    requestedAction: { v: 1, kind: 'enqueue' },
                    pending: { deliveryStatus: { status: 'external_handoff' } },
                });
            }
            return new Response(null, { status: 204 });
        };

        const enqueue = enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'external provider owns this input',
            encryption,
            deliveryMode: 'external_handoff',
            outboxScope: targetScope,
            request,
        });
        await postStartedGate;
        const cancel = deletePendingMessageV2({
            sessionId,
            pendingId: localId,
            outboxScope: targetScope,
            request,
        });
        releasePost();

        await expect(Promise.all([enqueue, cancel])).resolves.toEqual([
            expect.objectContaining({ localId, accepted: true, cancelled: true }),
            undefined,
        ]);
        expect(methods).toEqual(['POST', 'DELETE']);
        expect((await loadPendingOutboxForSession(sessionId, targetScope))).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                deliveryStatus: 'accepted',
                pendingDeliveryStatus: 'external_handoff',
            }),
        ]);
    });

    it('preserves refreshed canonical external custody when cancel races the POST acknowledgement', async () => {
        const sessionId = 's_external_handoff_refresh_cancel_race';
        const localId = 'external-handoff-refresh-cancel-race';
        const canonicalRawRecord = {
            role: 'user' as const,
            content: { type: 'text' as const, text: 'canonical server input' },
            meta: { source: 'server' },
        };
        storage.getState().applySessions([buildSession({
            sessionId,
            overrides: { encryptionMode: 'plain' },
        })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 5 });
        let releasePost!: () => void;
        const postGate = new Promise<void>((resolve) => { releasePost = resolve; });
        let postStarted!: () => void;
        const postStartedGate = new Promise<void>((resolve) => { postStarted = resolve; });
        let releaseDelete!: () => void;
        const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
        let deleteStarted!: () => void;
        const deleteStartedGate = new Promise<void>((resolve) => { deleteStarted = resolve; });
        const request = async (_path: string, init?: RequestInit): Promise<Response> => {
            const method = init?.method ?? 'GET';
            if (method === 'POST') {
                postStarted();
                await postGate;
                return Response.json({
                    requestedAction: { v: 1, kind: 'enqueue' },
                    pending: { deliveryStatus: { status: 'external_handoff' } },
                });
            }
            if (method === 'DELETE') {
                deleteStarted();
                await deleteGate;
                return new Response(null, { status: 204 });
            }
            return Response.json({
                pending: [{
                    localId,
                    content: { t: 'plain', v: canonicalRawRecord },
                    requestedAction: { v: 1, kind: 'enqueue' },
                    status: 'queued',
                    position: 0,
                    createdAt: 222,
                    updatedAt: 223,
                    discardedAt: null,
                    discardedReason: null,
                }],
            });
        };

        const enqueue = enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'local auxiliary input',
            metaOverrides: { source: 'local' },
            encryption,
            deliveryMode: 'external_handoff',
            outboxScope: targetScope,
            request,
        });
        await postStartedGate;
        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: targetScope,
            isOutboxScopeCurrent: () => true,
            request,
        });
        expect((await loadPendingOutboxForSession(sessionId, targetScope))).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                source: 'server_pending',
                text: 'canonical server input',
                rawRecord: canonicalRawRecord,
            }),
        ]);

        const deletion = deletePendingMessageV2({
            sessionId,
            pendingId: localId,
            outboxScope: targetScope,
            request,
        });
        await deleteStartedGate;
        releasePost();
        await enqueue;
        releaseDelete();
        await deletion;

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                source: 'server_pending',
                deliveryStatus: 'accepted',
                pendingDeliveryStatus: 'external_handoff',
                text: 'canonical server input',
                rawRecord: canonicalRawRecord,
            }),
        ]);
    });

    it('preserves confirmed external-handoff custody when cancel races a replay POST acknowledgement', async () => {
        const sessionId = 's_external_handoff_cancel_races_replay_ack';
        const localId = 'external-handoff-cancel-races-replay-ack';
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'replayed external handoff' }, meta: {} };
        (await savePendingOutboxMessage({
            sessionId,
            localId,
            createdAt: 42,
            text: 'replayed external handoff',
            rawRecord,
            request: {
                v: 1,
                body: JSON.stringify({
                    localId,
                    content: { t: 'plain', v: rawRecord },
                    messageRole: 'user',
                    deliveryMode: 'external_handoff',
                }),
            },
        }, targetScope));
        (await replayPersistedPendingOutboxForSession(sessionId, targetScope));
        let releasePost!: () => void;
        const postGate = new Promise<void>((resolve) => { releasePost = resolve; });
        let postStarted!: () => void;
        const postStartedGate = new Promise<void>((resolve) => { postStarted = resolve; });
        const methods: string[] = [];
        const request = async (_path: string, init?: RequestInit): Promise<Response> => {
            const method = init?.method ?? 'GET';
            methods.push(method);
            if (method === 'POST') {
                postStarted();
                await postGate;
                return Response.json({
                    requestedAction: { v: 1, kind: 'enqueue' },
                    pending: { deliveryStatus: { status: 'external_handoff' } },
                });
            }
            return new Response(null, { status: 204 });
        };

        const retry = retryPendingOutboxOperationV2({ sessionId, localId, outboxScope: targetScope, request });
        await postStartedGate;
        const cancel = deletePendingMessageV2({ sessionId, pendingId: localId, outboxScope: targetScope, request });
        releasePost();

        await expect(Promise.all([retry, cancel])).resolves.toEqual([{ accepted: true }, undefined]);
        expect(methods).toEqual(['POST', 'DELETE']);
        expect((await loadPendingOutboxForSession(sessionId, targetScope))).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                deliveryStatus: 'accepted',
                pendingDeliveryStatus: 'external_handoff',
            }),
        ]);
    });

    it('replays identifiable persisted quarantines visibly without scheduling or transport', async () => {
        const sessionId = 's_quarantined_persisted_rows';
        const rows = [
            {
                localId: 'unknown-operation', createdAt: 1, text: 'unknown operation',
                rawRecord: { role: 'user', content: { type: 'text', text: 'unknown operation' } },
                operation: 'replace',
                request: { v: 1, body: JSON.stringify({ localId: 'unknown-operation', content: { t: 'plain', v: {} }, messageRole: 'user' }) },
            },
            {
                localId: '..', createdAt: 2, text: 'unsafe identifier',
                rawRecord: { role: 'user', content: { type: 'text', text: 'unsafe identifier' } },
                operation: 'enqueue',
                request: { v: 1, body: JSON.stringify({ localId: '..', content: { t: 'plain', v: {} }, messageRole: 'user' }) },
            },
            {
                localId: 'invalid-envelope', createdAt: 3, text: 'invalid envelope',
                rawRecord: { role: 'user', content: { type: 'text', text: 'invalid envelope' } },
                operation: 'enqueue',
                request: { v: 1, body: JSON.stringify({ localId: 'invalid-envelope', content: {}, messageRole: 'user' }) },
            },
            {
                localId: 'nested-encrypted-content', createdAt: 6, text: 'nested encrypted content',
                rawRecord: { role: 'user' }, operation: 'enqueue',
                request: { v: 1, body: JSON.stringify({ localId: 'nested-encrypted-content', content: { t: 'encrypted', c: 'nested' }, messageRole: 'user' }) },
            },
            {
                localId: 'ciphertext-with-malformed-content', createdAt: 7, text: 'ambiguous encrypted content',
                rawRecord: { role: 'user' }, operation: 'enqueue',
                request: { v: 1, body: JSON.stringify({ localId: 'ciphertext-with-malformed-content', ciphertext: 'top-level', content: {}, messageRole: 'user' }) },
            },
        ];
        getPersistenceStorage().set(
            scopedSessionLocalStateKey('session-pending-outbox-v1', targetScope),
            JSON.stringify({ [sessionId]: rows }),
        );
        expect((await replayPersistedPendingOutboxForSession(sessionId, targetScope))).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual(expect.arrayContaining([
            expect.objectContaining({
                localId: 'unknown-operation',
                pendingOutboxQuarantineReason: 'unsupported_persisted_operation',
                pendingDeliveryStatus: 'blocked',
            }),
            expect.objectContaining({
                localId: '..',
                pendingOutboxQuarantineReason: 'invalid_persisted_local_id',
                pendingDeliveryStatus: 'blocked',
            }),
            expect.objectContaining({
                localId: 'invalid-envelope',
                pendingOutboxQuarantineReason: 'invalid_persisted_envelope',
                pendingDeliveryStatus: 'blocked',
            }),
            expect.objectContaining({
                localId: 'nested-encrypted-content',
                pendingOutboxQuarantineReason: 'invalid_persisted_envelope',
                pendingDeliveryStatus: 'blocked',
            }),
            expect.objectContaining({
                localId: 'ciphertext-with-malformed-content',
                pendingOutboxQuarantineReason: 'invalid_persisted_envelope',
                pendingDeliveryStatus: 'blocked',
            }),
        ]));
        let requestCalled = false;
        await expect(retryPendingOutboxOperationV2({
            sessionId,
            localId: 'unknown-operation',
            outboxScope: targetScope,
            request: async () => {
                requestCalled = true;
                return Response.json({});
            },
        })).resolves.toEqual({ accepted: false, terminal: true });
        await expect(retryPendingOutboxOperationV2({
            sessionId,
            localId: '..',
            outboxScope: targetScope,
            request: async () => {
                requestCalled = true;
                return Response.json({});
            },
        })).rejects.toThrow('Pending message ID cannot be a dot path segment');
        await expect(updatePendingRequestedActionV2({
            sessionId,
            localId: 'unknown-operation',
            requestedAction: { v: 1, kind: 'send_now' },
            outboxScope: targetScope,
            request: async () => {
                requestCalled = true;
                return Response.json({ didUpdate: true });
            },
        })).rejects.toThrow('Persisted Pending outbox row is quarantined');
        await expect(retryPendingOutboxOperationV2({
            sessionId,
            localId: 'invalid-envelope',
            outboxScope: targetScope,
            request: async () => {
                requestCalled = true;
                return Response.json({});
            },
        })).resolves.toEqual({ accepted: false, terminal: true });
        await expect(retryPendingOutboxOperationV2({
            sessionId,
            localId: 'ciphertext-with-malformed-content',
            outboxScope: targetScope,
            request: async () => {
                requestCalled = true;
                return Response.json({});
            },
        })).resolves.toEqual({ accepted: false, terminal: true });
        expect(requestCalled).toBe(false);
    });

    it('reuses the actual quarantine diagnostic beside same-localId server authority', async () => {
        const sessionId = 's_quarantine_retry_actual_diagnostic';
        const localId = 'quarantine-retry-actual-diagnostic';
        getPersistenceStorage().set(
            scopedSessionLocalStateKey('session-pending-outbox-v1', targetScope),
            JSON.stringify({
                [sessionId]: [{
                    localId,
                    createdAt: 1,
                    text: 'durable quarantine',
                    rawRecord: { role: 'user' },
                    operation: 'replace',
                    request: { v: 1, body: JSON.stringify({ localId, content: { t: 'plain', v: {} }, messageRole: 'user' }) },
                }],
            }),
        );
        (await replayPersistedPendingOutboxForSession(sessionId, targetScope));
        const originalDiagnostic = storage.getState().sessionPending[sessionId]?.messages[0]!;
        storage.getState().removePendingMessage(sessionId, originalDiagnostic.id);
        storage.getState().upsertPendingMessage(sessionId, {
            id: originalDiagnostic.id,
            localId,
            createdAt: 2,
            updatedAt: 2,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'server_queued',
            text: 'canonical server authority',
            rawRecord: { role: 'user', content: { type: 'text', text: 'canonical server authority' }, meta: {} },
        });
        (await replayPersistedPendingOutboxForSession(sessionId, targetScope));
        const collisionSafeDiagnostic = storage.getState().sessionPending[sessionId]?.messages.find((message) =>
            message.pendingOutboxQuarantineReason !== undefined
        )!;
        storage.getState().removePendingMessage(sessionId, originalDiagnostic.id);
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId,
            localId,
            createdAt: 3,
            updatedAt: 3,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'server_queued',
            text: 'same-localId canonical authority',
            rawRecord: { role: 'user', content: { type: 'text', text: 'same-localId canonical authority' }, meta: {} },
        });

        await expect(retryPendingOutboxOperationV2({
            sessionId,
            localId,
            outboxScope: targetScope,
            request: async () => {
                throw new Error('quarantine retry must not transport');
            },
        })).resolves.toEqual({ accepted: false, terminal: true });

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ id: collisionSafeDiagnostic.id, pendingOutboxQuarantineReason: 'unsupported_persisted_operation' }),
            expect.objectContaining({ id: localId, source: 'server_pending', text: 'same-localId canonical authority' }),
        ]);
    });

    it('allocates a collision-safe diagnostic for direct quarantined enqueue rejoin', async () => {
        const sessionId = 's_quarantine_direct_rejoin_collision';
        const localId = 'quarantine-direct-rejoin-collision';
        storage.getState().applySessions([buildSession({ sessionId })]);
        getPersistenceStorage().set(
            scopedSessionLocalStateKey('session-pending-outbox-v1', targetScope),
            JSON.stringify({
                [sessionId]: [{
                    localId,
                    createdAt: 1,
                    text: 'durable quarantine',
                    rawRecord: { role: 'user' },
                    operation: 'replace',
                    request: { v: 1, body: JSON.stringify({ localId, content: { t: 'plain', v: {} }, messageRole: 'user' }) },
                }],
            }),
        );
        (await replayPersistedPendingOutboxForSession(sessionId, targetScope));
        const syntheticBaseId = storage.getState().sessionPending[sessionId]?.messages[0]!.id;
        storage.getState().removePendingMessage(sessionId, syntheticBaseId);
        storage.getState().upsertPendingMessage(sessionId, {
            id: syntheticBaseId,
            localId: 'unrelated-server-local-id',
            createdAt: 2,
            updatedAt: 2,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'server_queued',
            text: 'server row at synthetic base',
            rawRecord: { role: 'user', content: { type: 'text', text: 'server row at synthetic base' }, meta: {} },
        });
        let requestCalled = false;

        await expect(enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'caller rejoin text',
            encryption: await createPendingQueueEncryption({ sessionId }),
            outboxScope: targetScope,
            request: async () => {
                requestCalled = true;
                return Response.json({ requestedAction: { v: 1, kind: 'enqueue' } });
            },
        })).resolves.toEqual({ localId, accepted: false, terminal: true });

        expect(requestCalled).toBe(false);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ id: syntheticBaseId, source: 'server_pending', text: 'server row at synthetic base' }),
            expect.objectContaining({
                localId,
                pendingOutboxQuarantineReason: 'unsupported_persisted_operation',
            }),
        ]);
        expect(storage.getState().sessionPending[sessionId]?.messages[1]?.id).not.toBe(syntheticBaseId);
    });

    it('reserves canonical discarded IDs across quarantine replay, direct rejoin, and refresh', async () => {
        const sessionId = 's_quarantine_discarded_id_reservation';
        const localId = 'quarantine-discarded-id-reservation';
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        getPersistenceStorage().set(
            scopedSessionLocalStateKey('session-pending-outbox-v1', targetScope),
            JSON.stringify({
                [sessionId]: [{
                    localId,
                    createdAt: 1,
                    text: 'durable quarantine',
                    rawRecord: { role: 'user' },
                    operation: 'replace',
                    request: { v: 1, body: JSON.stringify({ localId, content: { t: 'plain', v: {} }, messageRole: 'user' }) },
                }],
            }),
        );
        (await replayPersistedPendingOutboxForSession(sessionId, targetScope));
        const discardedId = storage.getState().sessionPending[sessionId]?.messages[0]!.id;
        storage.getState().applyPendingSnapshot(sessionId, {
            messages: [],
            discarded: [{
                id: discardedId,
                localId: 'canonical-discarded-local-id',
                createdAt: 2,
                updatedAt: 2,
                source: 'server_pending',
                deliveryStatus: 'accepted',
                text: 'canonical discarded',
                rawRecord: { role: 'user', content: { type: 'text', text: 'canonical discarded' }, meta: {} },
                discardedAt: 3,
                discardedReason: 'manual',
            }],
        });

        (await replayPersistedPendingOutboxForSession(sessionId, targetScope));
        let diagnostic = storage.getState().sessionPending[sessionId]?.messages.find((message) =>
            message.pendingOutboxQuarantineReason !== undefined
        )!;
        expect(diagnostic.id).not.toBe(discardedId);
        expect(storage.getState().sessionPending[sessionId]?.discarded).toEqual([
            expect.objectContaining({ id: discardedId, source: 'server_pending' }),
        ]);

        storage.getState().removePendingMessage(sessionId, diagnostic.id);
        await expect(enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'direct rejoin',
            encryption: await createPendingQueueEncryption({ sessionId }),
            outboxScope: targetScope,
            request: async () => {
                throw new Error('quarantine rejoin must not transport');
            },
        })).resolves.toEqual({ localId, accepted: false, terminal: true });
        diagnostic = storage.getState().sessionPending[sessionId]?.messages.find((message) =>
            message.pendingOutboxQuarantineReason !== undefined
        )!;
        expect(diagnostic.id).not.toBe(discardedId);

        storage.getState().removePendingMessage(sessionId, diagnostic.id);
        const encryption = await createPendingQueueEncryption({ sessionId });
        const discardedResponse = () => Response.json({
            pending: [{
                localId: discardedId,
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'canonical discarded' }, meta: {} } },
                requestedAction: { v: 1, kind: 'enqueue' },
                status: 'discarded',
                position: 0,
                createdAt: 2,
                updatedAt: 3,
                discardedAt: 3,
                discardedReason: 'manual',
            }],
        });
        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: targetScope,
            isOutboxScopeCurrent: () => true,
            request: async () => discardedResponse(),
        });
        diagnostic = storage.getState().sessionPending[sessionId]?.messages.find((message) =>
            message.pendingOutboxQuarantineReason !== undefined
        )!;
        expect(diagnostic.id).not.toBe(discardedId);

        const mutations: string[] = [];
        await restoreDiscardedPendingMessageV2({
            sessionId,
            pendingId: discardedId,
            encryption,
            outboxScope: targetScope,
            isOutboxScopeCurrent: () => true,
            request: async (path) => {
                mutations.push(path);
                return path.endsWith('?includeDiscarded=1') ? discardedResponse() : new Response(null, { status: 200 });
            },
        });
        await deleteDiscardedPendingMessageV2({
            sessionId,
            pendingId: discardedId,
            encryption,
            outboxScope: targetScope,
            isOutboxScopeCurrent: () => true,
            request: async (path, init) => {
                mutations.push(path);
                if (init?.method === 'DELETE') return new Response(null, { status: 204 });
                return Response.json({ pending: [] });
            },
        });
        expect(mutations).toEqual([
            `/v2/sessions/${sessionId}/pending/${encodeURIComponent(discardedId)}/restore`,
            `/v2/sessions/${sessionId}/pending?includeDiscarded=1`,
            `/v2/sessions/${sessionId}/pending/${encodeURIComponent(discardedId)}`,
            `/v2/sessions/${sessionId}/pending?includeDiscarded=1`,
        ]);
    });

    it('retires only same-scope enqueue custody after a requested-action update proves server presence', async () => {
        const sessionId = 's_action_update_reconciles_enqueue';
        const localId = 'action-update-reconciles-enqueue';
        const save = async (scope: typeof targetScope | typeof otherScope) => (await savePendingOutboxMessage({
            sessionId,
            localId,
            createdAt: 42,
            text: 'server-owned after action update',
            rawRecord: { role: 'user', content: { type: 'text', text: 'server-owned after action update' }, meta: {} },
            request: {
                v: 1,
                body: JSON.stringify({
                    localId,
                    content: { t: 'plain', v: {} },
                    messageRole: 'user',
                }),
            },
        }, scope));
        (await save(targetScope));
        (await save(otherScope));

        await updatePendingRequestedActionV2({
            sessionId,
            localId,
            requestedAction: { v: 1, kind: 'send_now' },
            outboxScope: targetScope,
            request: async () => Response.json({ didUpdate: true }),
        });

        expect((await loadPendingOutboxForSession(sessionId, targetScope))).toEqual([]);
        expect((await loadPendingOutboxForSession(sessionId, otherScope))).toEqual([
            expect.objectContaining({ localId, operation: 'enqueue' }),
        ]);
    });

    it.each([true, false])(
        'retires acknowledged requested-action outbox custody without manufacturing server snapshot provenance (didUpdate=%s)',
        async (didUpdate) => {
            const sessionId = `s_action_update_server_proof_${didUpdate}`;
            const localId = `action-update-server-proof-${didUpdate}`;
            const rawRecord = {
                role: 'user' as const,
                content: { type: 'text' as const, text: 'already acknowledged enqueue' },
                meta: {},
            };
            storage.getState().applySessions([buildSession({ sessionId })]);
            (await savePendingOutboxMessage({
                sessionId,
                localId,
                createdAt: 42,
                text: 'already acknowledged enqueue',
                rawRecord,
                request: {
                    v: 1,
                    body: JSON.stringify({
                        localId,
                        content: { t: 'plain', v: rawRecord },
                        messageRole: 'user',
                    }),
                },
            }, targetScope));
            storage.getState().upsertPendingMessage(sessionId, {
                id: localId,
                localId,
                createdAt: 42,
                updatedAt: 42,
                source: 'local_outbound',
                deliveryStatus: 'queued',
                pendingOutboxScope: targetScope,
                pendingOutboxOperation: 'enqueue',
                sendState: 'unconfirmed',
                text: 'already acknowledged enqueue',
                rawRecord,
            });

            await updatePendingRequestedActionV2({
                sessionId,
                localId,
                requestedAction: { v: 1, kind: 'steer_if_active' },
                outboxScope: targetScope,
                request: async () => {
                    // The authoritative zero-count push may arrive before this PATCH response.
                    // Ambiguous enqueue custody must keep the local row visible until the exact
                    // acknowledgement is consumed, but that acknowledgement is not a snapshot.
                    storage.getState().pruneServerPendingMessages(sessionId);
                    expect(storage.getState().sessionPending[sessionId]?.messages).toHaveLength(1);
                    return Response.json({ didUpdate });
                },
            });

            expect((await loadPendingOutboxForSession(sessionId, targetScope))).toEqual([]);
            expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
                expect.objectContaining({
                    localId,
                    source: 'local_outbound',
                    deliveryStatus: 'accepted',
                    pendingOutboxOperation: undefined,
                    sendState: undefined,
                }),
            ]);

            storage.getState().applyMessages(sessionId, [{
                id: `committed-${localId}`,
                seq: 1,
                localId,
                createdAt: 43,
                isSidechain: false,
                role: 'user',
                content: { type: 'text', text: 'already acknowledged enqueue' },
            }]);

            expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
        },
    );

    it('requires a confirmed server DELETE after requested-action success retires enqueue custody', async () => {
        const sessionId = 's_action_update_delete_requires_server_proof';
        const localId = 'action-update-delete-requires-server-proof';
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'server-proven pending' }, meta: {} };
        (await savePendingOutboxMessage({
            sessionId,
            localId,
            createdAt: 42,
            text: 'server-proven pending',
            rawRecord,
            request: {
                v: 1,
                body: JSON.stringify({
                    localId,
                    content: { t: 'plain', v: rawRecord },
                    messageRole: 'user',
                    requestedAction: { v: 1, kind: 'enqueue' },
                }),
            },
        }, targetScope));
        (await replayPersistedPendingOutboxForSession(sessionId, targetScope));

        await updatePendingRequestedActionV2({
            sessionId,
            localId,
            requestedAction: { v: 1, kind: 'send_now' },
            outboxScope: targetScope,
            request: async () => Response.json({ didUpdate: true }),
        });
        expect((await loadPendingOutboxForSession(sessionId, targetScope))).toEqual([]);

        let failedDeleteCalled = false;
        await expect(deletePendingMessageV2({
            sessionId,
            pendingId: localId,
            outboxScope: targetScope,
            request: async () => {
                failedDeleteCalled = true;
                return new Response(null, { status: 500 });
            },
        })).rejects.toThrow('Failed to delete pending message (500)');
        expect(failedDeleteCalled).toBe(true);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId, source: 'local_outbound', deliveryStatus: 'accepted' }),
        ]);

        let absentDeleteCalled = false;
        await deletePendingMessageV2({
            sessionId,
            pendingId: localId,
            outboxScope: targetScope,
            request: async () => {
                absentDeleteCalled = true;
                return new Response(null, { status: 404 });
            },
        });
        expect(absentDeleteCalled).toBe(true);
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });

    it('does not retire cancel or newly quarantined custody after a requested-action update', async () => {
        const cancelSessionId = 's_action_update_keeps_cancel';
        const cancelLocalId = 'action-update-keeps-cancel';
        (await savePendingOutboxMessage({
            sessionId: cancelSessionId,
            localId: cancelLocalId,
            createdAt: 42,
            text: 'cancel remains durable',
            rawRecord: { role: 'user', content: { type: 'text', text: 'cancel remains durable' }, meta: {} },
            request: {
                v: 1,
                body: JSON.stringify({ localId: cancelLocalId, content: { t: 'plain', v: {} }, messageRole: 'user' }),
            },
        }, targetScope));
        (await markPendingOutboxMessageCancelRequested(cancelSessionId, cancelLocalId, targetScope));

        await updatePendingRequestedActionV2({
            sessionId: cancelSessionId,
            localId: cancelLocalId,
            requestedAction: { v: 1, kind: 'send_now' },
            outboxScope: targetScope,
            request: async () => Response.json({ didUpdate: true }),
        });
        expect((await loadPendingOutboxForSession(cancelSessionId, targetScope))).toEqual([
            expect.objectContaining({ localId: cancelLocalId, operation: 'cancel' }),
        ]);

        const quarantineSessionId = 's_action_update_keeps_quarantine';
        const quarantineLocalId = 'action-update-keeps-quarantine';
        (await savePendingOutboxMessage({
            sessionId: quarantineSessionId,
            localId: quarantineLocalId,
            createdAt: 42,
            text: 'becomes quarantined during request',
            rawRecord: { role: 'user', content: { type: 'text', text: 'becomes quarantined during request' }, meta: {} },
            request: {
                v: 1,
                body: JSON.stringify({ localId: quarantineLocalId, content: { t: 'plain', v: {} }, messageRole: 'user' }),
            },
        }, targetScope));
        await updatePendingRequestedActionV2({
            sessionId: quarantineSessionId,
            localId: quarantineLocalId,
            requestedAction: { v: 1, kind: 'send_now' },
            outboxScope: targetScope,
            request: async () => {
                getPersistenceStorage().set(
                    scopedSessionLocalStateKey('session-pending-outbox-v1', targetScope),
                    JSON.stringify({
                        [quarantineSessionId]: [{
                            localId: quarantineLocalId,
                            createdAt: 42,
                            text: 'becomes quarantined during request',
                            rawRecord: { role: 'user' },
                            operation: 'enqueue',
                            request: { v: 1, body: '{}' },
                        }],
                    }),
                );
                return Response.json({ didUpdate: true });
            },
        });
        expect((await loadPendingOutboxForSession(quarantineSessionId, targetScope))).toEqual([
            expect.objectContaining({ localId: quarantineLocalId, operation: 'quarantined' }),
        ]);
    });

    it('replays exact enqueue and cancel custody with safe auxiliary metadata fallbacks', async () => {
        const sessionId = 's_invalid_auxiliary_projection_metadata';
        const enqueueLocalId = 'invalid-created-at-enqueue';
        const cancelLocalId = 'invalid-text-cancel';
        const enqueueBody = JSON.stringify({
            localId: enqueueLocalId,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'enqueue body' }, meta: {} } },
            messageRole: 'user',
        });
        const cancelBody = JSON.stringify({
            localId: cancelLocalId,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'cancel body' }, meta: {} } },
            messageRole: 'user',
        });
        getPersistenceStorage().set(
            scopedSessionLocalStateKey('session-pending-outbox-v1', targetScope),
            JSON.stringify({
                [sessionId]: [
                    {
                        localId: enqueueLocalId,
                        createdAt: null,
                        text: 'safe enqueue text',
                        rawRecord: null,
                        operation: 'enqueue',
                        request: { v: 1, body: enqueueBody },
                    },
                    {
                        localId: cancelLocalId,
                        createdAt: 9,
                        rawRecord: { role: 'assistant' },
                        operation: 'cancel',
                        request: { v: 1, body: cancelBody },
                    },
                ],
            }),
        );

        expect((await replayPersistedPendingOutboxForSession(sessionId, targetScope))).toEqual([
            enqueueLocalId,
            cancelLocalId,
        ]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual(expect.arrayContaining([
            expect.objectContaining({
                localId: enqueueLocalId,
                createdAt: 0,
                text: 'safe enqueue text',
                pendingOutboxOperation: 'enqueue',
                rawRecord: {
                    role: 'user',
                    content: { type: 'text', text: 'safe enqueue text' },
                    meta: {},
                },
            }),
            expect.objectContaining({
                localId: cancelLocalId,
                createdAt: 9,
                text: '',
                pendingOutboxOperation: 'cancel',
                rawRecord: {
                    role: 'user',
                    content: { type: 'text', text: '' },
                    meta: {},
                },
            }),
        ]));

        const requests: Array<{ path: string; method: string | undefined; body: string }> = [];
        const request = async (path: string, init?: RequestInit) => {
            requests.push({ path, method: init?.method, body: String(init?.body ?? '') });
            return init?.method === 'DELETE'
                ? new Response(null, { status: 204 })
                : Response.json({ requestedAction: { v: 1, kind: 'enqueue' } });
        };
        await retryPendingOutboxOperationV2({
            sessionId,
            localId: enqueueLocalId,
            outboxScope: targetScope,
            request,
        });
        await retryPendingOutboxOperationV2({
            sessionId,
            localId: cancelLocalId,
            outboxScope: targetScope,
            request,
        });
        expect(requests).toEqual([
            {
                path: `/v2/sessions/${sessionId}/pending`,
                method: 'POST',
                body: enqueueBody,
            },
            {
                path: `/v2/sessions/${sessionId}/pending/${cancelLocalId}`,
                method: 'DELETE',
                body: '',
            },
        ]);
    });

    it('replays the exact frozen request when auxiliary rawRecord is missing', async () => {
        const sessionId = 's_missing_auxiliary_raw_record';
        const localId = 'missing-auxiliary-raw-record';
        const body = JSON.stringify({
            localId,
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'frozen body' }, meta: {} } },
            messageRole: 'user',
        });
        getPersistenceStorage().set(
            scopedSessionLocalStateKey('session-pending-outbox-v1', targetScope),
            JSON.stringify({
                [sessionId]: [{
                    localId,
                    createdAt: 4,
                    text: 'safe projection text',
                    operation: 'enqueue',
                    request: { v: 1, body },
                }],
            }),
        );

        expect((await replayPersistedPendingOutboxForSession(sessionId, targetScope))).toEqual([localId]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                pendingOutboxOperation: 'enqueue',
                text: 'safe projection text',
                rawRecord: {
                    role: 'user',
                    content: { type: 'text', text: 'safe projection text' },
                    meta: {},
                },
            }),
        ]);
        const sentBodies: string[] = [];
        await expect(retryPendingOutboxOperationV2({
            sessionId,
            localId,
            outboxScope: targetScope,
            request: async (_path, init) => {
                sentBodies.push(String(init?.body ?? ''));
                return Response.json({ requestedAction: { v: 1, kind: 'enqueue' } });
            },
        })).resolves.toEqual({ accepted: true });
        expect(sentBodies).toEqual([body]);
    });

    it('reuses the exact persisted E2EE request body after an ambiguous write', async () => {
        const sessionId = 's_outbox_exact_e2ee';
        const localId = 'exact-e2ee-local';
        storage.getState().applySessions([buildSession({ sessionId })]);
        let encryptionCalls = 0;
        const encryption = {
            getSessionEncryption: () => ({
                encryptRawRecord: async () => `ciphertext-${++encryptionCalls}`,
            }),
        };
        const sentBodies: string[] = [];

        const first = await enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'exact encrypted prompt',
            encryption,
            outboxScope: targetScope,
            request: async (_path, init) => {
                sentBodies.push(String(init?.body ?? ''));
                throw new TypeError('Failed to fetch');
            },
        } as Parameters<typeof enqueuePendingMessageV2>[0]);
        expect(first.accepted).toBe(false);

        await expect(retryPendingOutboxOperationV2({
            sessionId,
            localId,
            encryption: encryption as never,
            outboxScope: targetScope,
            request: async (_path, init) => {
                sentBodies.push(String(init?.body ?? ''));
                return Response.json({ requestedAction: { v: 1, kind: 'enqueue' } });
            },
        } as Parameters<typeof retryPendingOutboxOperationV2>[0])).resolves.toEqual({ accepted: true });

        expect(sentBodies).toHaveLength(2);
        expect(sentBodies[1]).toBe(sentBodies[0]);
        expect(encryptionCalls).toBe(1);
    });

    it('replays an existing E2EE envelope by localId without requiring the session key again', async () => {
        const sessionId = 's_outbox_existing_without_key';
        const localId = 'existing-without-key';
        storage.getState().applySessions([buildSession({ sessionId })]);
        let keyAvailable = true;
        let encryptionCalls = 0;
        const encryption = {
            getSessionEncryption: () => keyAvailable ? {
                encryptRawRecord: async () => `ciphertext-${++encryptionCalls}`,
            } : null,
        };
        const sentBodies: string[] = [];
        await enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'persist me',
            encryption,
            outboxScope: targetScope,
            request: async (_path, init) => {
                sentBodies.push(String(init?.body ?? ''));
                throw new TypeError('Failed to fetch');
            },
        });
        keyAvailable = false;

        await expect(enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'must not replace persisted text',
            encryption,
            outboxScope: targetScope,
            request: async (_path, init) => {
                sentBodies.push(String(init?.body ?? ''));
                return Response.json({ requestedAction: { v: 1, kind: 'enqueue' } });
            },
        })).resolves.toEqual({ localId, accepted: true });

        expect(sentBodies[1]).toBe(sentBodies[0]);
        expect(encryptionCalls).toBe(1);
    });

    it('replays a durable cancellation as DELETE and never resends the stored prompt', async () => {
        const sessionId = 's_outbox_cancel_replay';
        const localId = 'cancel-replay-local';
        storage.getState().applySessions([buildSession({ sessionId })]);
        (await savePendingOutboxMessage({
            sessionId,
            localId,
            createdAt: 42,
            text: 'must not be resent',
            rawRecord: { role: 'user', content: { type: 'text', text: 'must not be resent' }, meta: {} },
            operation: 'cancel',
            request: {
                v: 1,
                body: JSON.stringify({ localId, content: { t: 'plain', v: {} }, messageRole: 'user' }),
            },
        }, targetScope));
        (await replayPersistedPendingOutboxForSession(sessionId, targetScope));
        const requests: Array<{ path: string; method?: string }> = [];

        await expect(retryPendingOutboxOperationV2({
            sessionId,
            localId,
            outboxScope: targetScope,
            request: async (path, init) => {
                requests.push({ path, method: init?.method });
                return new Response(null, { status: 404 });
            },
        })).resolves.toEqual({ accepted: true });

        expect(requests).toEqual([{ path: `/v2/sessions/${sessionId}/pending/${localId}`, method: 'DELETE' }]);
        expect((await loadPendingOutboxForSession(sessionId, targetScope))).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });

    it('removes an ordinary server row after cancellation retry but retains external handoff', async () => {
        const sessionId = 's_outbox_cancel_server_projection';
        const localId = 'cancel-server-projection';
        storage.getState().applySessions([buildSession({ sessionId })]);
        (await savePendingOutboxMessage({
            sessionId,
            localId,
            createdAt: 42,
            text: 'cancelled row',
            rawRecord: { role: 'user', content: { type: 'text', text: 'cancelled row' }, meta: {} },
            operation: 'cancel',
            request: { v: 1, body: JSON.stringify({ localId, content: { t: 'plain', v: {} }, messageRole: 'user' }) },
        }, targetScope));
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'ordinary-server-row', localId, createdAt: 42, updatedAt: 42,
            source: 'server_pending', deliveryStatus: 'accepted', pendingDeliveryStatus: 'server_queued',
            text: 'ordinary', rawRecord: { role: 'user', content: { type: 'text', text: 'ordinary' }, meta: {} },
        });
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'external-handoff-row', localId, createdAt: 43, updatedAt: 43,
            source: 'server_pending', deliveryStatus: 'accepted', pendingDeliveryStatus: 'external_handoff',
            text: 'external', rawRecord: { role: 'user', content: { type: 'text', text: 'external' }, meta: {} },
        });

        await retryPendingOutboxOperationV2({
            sessionId,
            localId,
            outboxScope: targetScope,
            request: async () => new Response(null, { status: 204 }),
        });

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ id: 'external-handoff-row', pendingDeliveryStatus: 'external_handoff' }),
        ]);
    });

    it('applies the same server-projection cleanup when direct rejoin completes a cancellation', async () => {
        const sessionId = 's_outbox_cancel_direct_projection';
        const localId = 'cancel-direct-projection';
        storage.getState().applySessions([buildSession({ sessionId })]);
        (await savePendingOutboxMessage({
            sessionId, localId, createdAt: 42, text: 'cancel direct', operation: 'cancel',
            rawRecord: { role: 'user', content: { type: 'text', text: 'cancel direct' }, meta: {} },
            request: { v: 1, body: JSON.stringify({ localId, content: { t: 'plain', v: {} }, messageRole: 'user' }) },
        }, targetScope));
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'ordinary-direct-row', localId, createdAt: 42, updatedAt: 42,
            source: 'server_pending', deliveryStatus: 'accepted', pendingDeliveryStatus: 'server_queued',
            text: 'ordinary', rawRecord: { role: 'user', content: { type: 'text', text: 'ordinary' }, meta: {} },
        });
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'external-direct-row', localId, createdAt: 43, updatedAt: 43,
            source: 'server_pending', deliveryStatus: 'accepted', pendingDeliveryStatus: 'external_handoff',
            pendingOutboxScope: targetScope,
            text: 'external', rawRecord: { role: 'user', content: { type: 'text', text: 'external' }, meta: {} },
        });

        await expect(enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'must not enqueue',
            encryption: { getSessionEncryption: () => null },
            outboxScope: targetScope,
            request: async () => new Response(null, { status: 204 }),
        })).resolves.toEqual({ localId, accepted: true, cancelled: true });

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ id: 'external-direct-row', pendingDeliveryStatus: 'external_handoff' }),
        ]);
    });

    it('removes ordinary canonical cancellation state while preserving external, quarantine, and cross-scope rows', async () => {
        const sessionId = 's_cancel_canonical_cleanup_boundaries';
        const localId = 'cancel-canonical-cleanup-boundaries';
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'cancel target' }, meta: {} };
        (await savePendingOutboxMessage({
            sessionId,
            localId,
            createdAt: 1,
            text: 'cancel target',
            rawRecord,
            operation: 'cancel',
            request: { v: 1, body: JSON.stringify({ localId, content: { t: 'plain', v: rawRecord }, messageRole: 'user' }) },
        }, targetScope));
        (await replayPersistedPendingOutboxForSession(sessionId, targetScope));
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'ordinary-unscoped-canonical', localId, createdAt: 2, updatedAt: 2,
            source: 'server_pending', deliveryStatus: 'accepted', pendingDeliveryStatus: 'server_queued',
            text: 'ordinary remove', rawRecord,
        });
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'external-unscoped-canonical', localId, createdAt: 3, updatedAt: 3,
            source: 'server_pending', deliveryStatus: 'accepted', pendingDeliveryStatus: 'external_handoff',
            text: 'external preserve', rawRecord,
        });
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'quarantine-preserve', localId, createdAt: 4, updatedAt: 4,
            source: 'local_outbound', deliveryStatus: 'queued', pendingDeliveryStatus: 'blocked',
            pendingOutboxScope: targetScope, pendingOutboxQuarantineReason: 'unsupported_persisted_operation',
            text: 'quarantine preserve', rawRecord,
        });
        storage.getState().upsertPendingMessage(sessionId, {
            id: 'cross-scope-canonical', localId, createdAt: 5, updatedAt: 5,
            source: 'server_pending', deliveryStatus: 'accepted', pendingDeliveryStatus: 'server_queued',
            pendingOutboxScope: otherScope, text: 'cross scope preserve', rawRecord,
        });
        const methods: string[] = [];

        await deletePendingMessageV2({
            sessionId,
            pendingId: localId,
            outboxScope: targetScope,
            request: async (_path, init) => {
                methods.push(init?.method ?? 'GET');
                return new Response(null, { status: 204 });
            },
        });

        expect(methods).toEqual(['DELETE']);
        expect((await loadPendingOutboxForSession(sessionId, targetScope))).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ id: 'external-unscoped-canonical', pendingDeliveryStatus: 'external_handoff' }),
            expect.objectContaining({ id: 'quarantine-preserve', pendingOutboxQuarantineReason: 'unsupported_persisted_operation' }),
            expect.objectContaining({ id: 'cross-scope-canonical', pendingOutboxScope: otherScope }),
        ]);
    });

    it.each([204, 404])('deletes the resolved synthetic canonical projection after %i without removing colliding diagnostics', async (status) => {
        const sessionId = 's_delete_resolved_synthetic_projection';
        const localId = 'delete-resolved-synthetic-projection';
        const canonicalId = 'delete-resolved-canonical-id';
        const sameScopeDiagnosticId = 'delete-same-scope-diagnostic';
        const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: 'delete target' }, meta: {} };
        getPersistenceStorage().set(
            scopedSessionLocalStateKey('session-pending-outbox-v1', targetScope),
            JSON.stringify({
                [sessionId]: [{
                    localId,
                    createdAt: 1,
                    text: 'durable quarantine',
                    rawRecord: { role: 'user' },
                    operation: 'replace',
                    request: { v: 1, body: JSON.stringify({ localId, content: { t: 'plain', v: {} }, messageRole: 'user' }) },
                }],
            }),
        );
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId, localId: 'other-scope-diagnostic-local', createdAt: 1, updatedAt: 1,
            source: 'local_outbound', deliveryStatus: 'queued', pendingDeliveryStatus: 'blocked',
            pendingOutboxScope: otherScope, pendingOutboxQuarantineReason: 'unsupported_persisted_operation',
            text: 'other scope diagnostic', rawRecord,
        });
        storage.getState().upsertPendingMessage(sessionId, {
            id: sameScopeDiagnosticId, localId, createdAt: 2, updatedAt: 2,
            source: 'local_outbound', deliveryStatus: 'queued', pendingDeliveryStatus: 'blocked',
            pendingOutboxScope: targetScope, pendingOutboxQuarantineReason: 'unsupported_persisted_operation',
            text: 'same scope diagnostic', rawRecord,
        });
        storage.getState().upsertPendingMessage(sessionId, {
            id: canonicalId, localId, createdAt: 3, updatedAt: 3,
            source: 'server_pending', deliveryStatus: 'accepted', pendingDeliveryStatus: 'server_queued',
            pendingOutboxScope: targetScope, text: 'canonical delete target', rawRecord,
        });
        let requestCalled = false;

        await deletePendingMessageV2({
            sessionId,
            pendingId: localId,
            outboxScope: targetScope,
            request: async () => {
                requestCalled = true;
                return new Response(null, { status });
            },
        });

        expect(requestCalled).toBe(true);
        expect((await loadPendingOutboxForSession(sessionId, targetScope))).toEqual([
            expect.objectContaining({ localId, operation: 'quarantined' }),
        ]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ id: localId, pendingOutboxScope: otherScope }),
            expect.objectContaining({ id: sameScopeDiagnosticId, pendingOutboxScope: targetScope }),
        ]);
    });

    it('does not turn a durable cancellation back into enqueue when the caller retries the original localId', async () => {
        const sessionId = 's_outbox_cancel_original_retry';
        const localId = 'cancel-original-local';
        storage.getState().applySessions([buildSession({ sessionId })]);
        (await savePendingOutboxMessage({
            sessionId, localId, createdAt: 42, text: 'must stay cancelled', operation: 'cancel',
            rawRecord: { role: 'user', content: { type: 'text', text: 'must stay cancelled' }, meta: {} },
            request: { v: 1, body: JSON.stringify({ localId, content: { t: 'plain', v: {} }, messageRole: 'user' }) },
        }, targetScope));
        const requests: Array<{ path: string; method?: string }> = [];

        await expect(enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'must stay cancelled',
            encryption: { getSessionEncryption: () => null },
            outboxScope: targetScope,
            request: async (path, init) => {
                requests.push({ path, method: init?.method });
                return new Response(null, { status: 404 });
            },
        })).resolves.toEqual({ localId, accepted: true, cancelled: true });

        expect(requests).toEqual([{ path: `/v2/sessions/${sessionId}/pending/${localId}`, method: 'DELETE' }]);
    });
});
