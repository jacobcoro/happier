import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Encryption } from '@/sync/encryption/encryption';
import { settingsParse } from '@/sync/domains/settings/settings';
import type { Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    loadPendingOutboxForSession,
    savePendingOutboxMessage,
} from '@/sync/domains/state/pendingOutboxPersistence';

import {
    deleteDiscardedPendingMessageV2,
    deletePendingMessageV2 as deletePendingMessageV2Impl,
    enqueuePendingMessageV2 as enqueuePendingMessageV2Impl,
    fetchAndApplyPendingMessagesV2,
    replayPersistedPendingOutboxForSession,
    retryPendingOutboxOperationV2 as retryPendingOutboxOperationV2Impl,
} from './pendingQueueV2';
import { buildSession, createPendingQueueEncryption, resetPendingQueueState } from './pendingQueueV2.testHelpers';

const testOutboxScope = { serverId: 'server-test', accountId: 'account-test' } as const;
const enqueuePendingMessageV2 = (
    params: Omit<Parameters<typeof enqueuePendingMessageV2Impl>[0], 'outboxScope' | 'requestedAction' | 'wireMode'>,
) => enqueuePendingMessageV2Impl({
    ...params,
    outboxScope: testOutboxScope,
    requestedAction: { v: 1, kind: 'enqueue' },
    wireMode: 'pending_input_v1',
});
const deletePendingMessageV2 = (
    params: Omit<Parameters<typeof deletePendingMessageV2Impl>[0], 'outboxScope'>,
) => deletePendingMessageV2Impl({ ...params, outboxScope: testOutboxScope });
const retryPendingOutboxOperationV2 = (
    params: Omit<Parameters<typeof retryPendingOutboxOperationV2Impl>[0], 'wireMode'>,
) => retryPendingOutboxOperationV2Impl({ ...params, wireMode: 'pending_input_v1' });

function plainPendingBody(localId: string, text: string): string {
    return JSON.stringify({
        localId,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text }, meta: {} } },
        messageRole: 'user',
        requestedAction: { v: 1, kind: 'enqueue' },
    });
}

function acknowledgedEnqueueResponse(payload: Record<string, unknown> = {}): Response {
    return Response.json({
        requestedAction: { v: 1, kind: 'enqueue' },
        ...payload,
    });
}

function acknowledgedEnqueueResponseForRequest(
    init: RequestInit | undefined,
    payload: Record<string, unknown> = {},
): Response {
    const body = JSON.parse(String(init?.body ?? '{}')) as { localId?: unknown };
    const pending = payload.pending && typeof payload.pending === 'object' && !Array.isArray(payload.pending)
        ? payload.pending as Record<string, unknown>
        : {};
    return acknowledgedEnqueueResponse({
        ...payload,
        pending: { localId: body.localId, ...pending },
    });
}

async function persistLocalPending(params: Readonly<{
    sessionId: string;
    localId: string;
    text: string;
    scope: ServerAccountScope;
    operation?: 'enqueue' | 'cancel';
}>): Promise<void> {
    const rawRecord = { role: 'user' as const, content: { type: 'text' as const, text: params.text }, meta: {} };
    (await savePendingOutboxMessage({
        sessionId: params.sessionId,
        localId: params.localId,
        createdAt: 111,
        text: params.text,
        rawRecord,
        ...(params.operation ? { operation: params.operation } : {}),
        request: { v: 1, body: plainPendingBody(params.localId, params.text) },
    }, params.scope));
    storage.getState().upsertPendingMessage(params.sessionId, {
        id: params.localId,
        localId: params.localId,
        createdAt: 111,
        updatedAt: 111,
        source: 'local_outbound',
        deliveryStatus: 'queued',
        pendingOutboxScope: params.scope,
        pendingOutboxOperation: params.operation ?? 'enqueue',
        text: params.text,
        rawRecord,
    });
}

describe('pendingQueueV2 optimistic thinking', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        resetPendingQueueState();
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('keeps optimistic thinking and marks the pending row accepted after successful enqueue', async () => {
        const sessionId = 's_test';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 7 });

        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();

        const result = await enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption,
            request: async (_path, init) => acknowledgedEnqueueResponseForRequest(init),
        });

        expect(result).toEqual({
            localId: expect.any(String),
            accepted: true,
        });
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).not.toBeNull();
        expect(storage.getState().sessionPending[sessionId]?.messages[0]?.deliveryStatus).toBe('accepted');
    });

    it('marks encrypted pending enqueue payloads as user messages', async () => {
        const sessionId = 's_test_encrypted_message_role';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 7 });

        const bodies: unknown[] = [];
        await enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption,
            request: async (_path, init) => {
                bodies.push(JSON.parse(String(init?.body ?? 'null')));
                return acknowledgedEnqueueResponseForRequest(init);
            },
        });

        expect(bodies).toHaveLength(1);
        expect(bodies[0]).toEqual(expect.objectContaining({
            ciphertext: expect.any(String),
            messageRole: 'user',
        }));
    });

    it('retains custody when a non-terminal acknowledgement names another Pending local id', async () => {
        const sessionId = 's_test_wrong_ack_identity';
        const localId = 'expected-local-id';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 7 });

        await expect(enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'retain wrong acknowledgement identity',
            encryption,
            request: async () => acknowledgedEnqueueResponse({
                pending: { localId: 'different-local-id' },
            }),
        })).resolves.toEqual({ localId, accepted: false });
        expect((await loadPendingOutboxForSession(sessionId, testOutboxScope))).toEqual([
            expect.objectContaining({ localId, operation: 'enqueue' }),
        ]);
    });

    it('requires the server to atomically claim an external handoff before acknowledging enqueue', async () => {
        const sessionId = 's_test_external_handoff';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 7 });
        const bodies: unknown[] = [];

        const result = await enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            localId: 'voice-local-1',
            deliveryMode: 'external_handoff',
            encryption,
            request: async (_path, init) => {
                bodies.push(JSON.parse(String(init?.body ?? 'null')));
                return acknowledgedEnqueueResponseForRequest(init, {
                    pending: { deliveryStatus: { status: 'external_handoff' } },
                });
            },
        });

        expect(bodies).toEqual([expect.objectContaining({
            localId: 'voice-local-1',
            deliveryMode: 'external_handoff',
        })]);
        expect(result).toEqual({
            localId: 'voice-local-1',
            accepted: true,
            externalHandoffClaimed: true,
        });
        expect(storage.getState().sessionPending[sessionId]?.messages[0]?.pendingDeliveryStatus)
            .toBe('external_handoff');
    });

    it('fails closed when an external handoff enqueue response lacks the claimed state', async () => {
        const sessionId = 's_test_external_handoff_unclaimed';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 7 });

        await expect(enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            localId: 'voice-local-1',
            deliveryMode: 'external_handoff',
            encryption,
            request: async () => acknowledgedEnqueueResponse({
                pending: { localId: 'voice-local-1', deliveryStatus: { status: 'queued' } },
            }),
        })).resolves.toEqual({ localId: 'voice-local-1', accepted: false });
        expect((await loadPendingOutboxForSession(sessionId, testOutboxScope))).toEqual([
            expect.objectContaining({ localId: 'voice-local-1', operation: 'enqueue' }),
        ]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId: 'voice-local-1', source: 'local_outbound' }),
        ]);
    });

    it('uses the frozen action and external-handoff mode when rejoining an existing outbox row', async () => {
        const sessionId = 's_test_frozen_external_handoff';
        const localId = 'voice-frozen-local';
        const rawRecord = { role: 'user', content: { type: 'text', text: 'frozen' }, meta: {} } as const;
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        (await savePendingOutboxMessage({
            sessionId,
            localId,
            createdAt: 111,
            text: 'frozen',
            rawRecord,
            request: {
                v: 1,
                body: JSON.stringify({
                    localId,
                    content: { t: 'plain', v: rawRecord },
                    messageRole: 'user',
                    requestedAction: { v: 1, kind: 'send_now' },
                    deliveryMode: 'external_handoff',
                }),
            },
        }, testOutboxScope));
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 7 });
        const bodies: unknown[] = [];

        await expect(enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'ignored replacement',
            encryption,
            request: async (_path, init) => {
                bodies.push(JSON.parse(String(init?.body ?? 'null')));
                return acknowledgedEnqueueResponseForRequest(init, {
                    requestedAction: { v: 1, kind: 'send_now' },
                    pending: { deliveryStatus: { status: 'external_handoff' } },
                });
            },
        })).resolves.toEqual({
            localId,
            accepted: true,
            externalHandoffClaimed: true,
        });
        expect(bodies).toEqual([expect.objectContaining({
            requestedAction: { v: 1, kind: 'send_now' },
            deliveryMode: 'external_handoff',
        })]);
        expect(storage.getState().sessionPending[sessionId]?.messages[0]).toEqual(expect.objectContaining({
            requestedAction: { v: 1, kind: 'send_now' },
            pendingDeliveryStatus: 'external_handoff',
        }));
    });

    it('keeps a newly enqueued pending row in queued delivery state until the server accepts it', async () => {
        const sessionId = 's_test_delivery_state';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 7 });

        let acceptRequest!: () => void;
        const requestGate = new Promise<void>((resolve) => {
            acceptRequest = resolve;
        });

        const promise = enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption,
            request: async (_path, init) => {
                await requestGate;
                return acknowledgedEnqueueResponseForRequest(init);
            },
        });

        await vi.waitFor(() => expect(storage.getState().sessionPending[sessionId]?.messages[0]?.deliveryStatus).toBe('queued'));

        acceptRequest();
        await promise;

        expect(storage.getState().sessionPending[sessionId]?.messages[0]?.deliveryStatus).toBe('accepted');
    });

    it('notifies when the local pending row is projected before the server accepts it', async () => {
        const sessionId = 's_test_local_projection_callback';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 7 });
        const projections: Array<{ localId: string; status: unknown }> = [];

        let acceptRequest!: () => void;
        const requestGate = new Promise<void>((resolve) => {
            acceptRequest = resolve;
        });

        const promise = enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption,
            request: async (_path, init) => {
                await requestGate;
                return acknowledgedEnqueueResponseForRequest(init);
            },
            onLocalPendingProjectionCreated: ({ localId }) => {
                projections.push({
                    localId,
                    status: storage.getState().sessionPending[sessionId]?.messages[0]?.deliveryStatus,
                });
            },
        });

        await vi.waitFor(() => expect(projections).toEqual([{
            localId: expect.any(String),
            status: 'queued',
        }]));

        acceptRequest();
        await promise;

        expect(projections).toHaveLength(1);
        expect(storage.getState().sessionPending[sessionId]?.messages[0]?.deliveryStatus).toBe('accepted');
    });

    it('durably records remove while POST is held and reloads as cancel before scoped DELETE', async () => {
        const sessionId = 's_test_delete_during_enqueue';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 13 });

        let postStarted!: () => void;
        const postStartedGate = new Promise<void>((resolve) => {
            postStarted = resolve;
        });
        let releaseRequest!: () => void;
        const requestGate = new Promise<void>((resolve) => {
            releaseRequest = resolve;
        });
        const requestCalls: Array<{ path: string; method: string | undefined }> = [];
        const request = async (path: string, init?: RequestInit) => {
            requestCalls.push({ path, method: init?.method });
            if (init?.method === 'POST') {
                postStarted();
                await requestGate;
            }
            return init?.method === 'POST'
                ? acknowledgedEnqueueResponseForRequest(init)
                : acknowledgedEnqueueResponse();
        };

        const enqueuePromise = enqueuePendingMessageV2({
            sessionId,
            text: 'delete me',
            encryption,
            request,
        });

        await postStartedGate;
        const localId = storage.getState().sessionPending[sessionId]?.messages[0]?.localId;
        expect(localId).toEqual(expect.any(String));

        await postStartedGate;

        const deletePromise = deletePendingMessageV2({
            sessionId,
            pendingId: localId!,
            request,
        });

        await vi.waitFor(async () => expect(await loadPendingOutboxForSession(sessionId, testOutboxScope)).toEqual([
            expect.objectContaining({ localId, operation: 'cancel' }),
        ]));

        storage.getState().removePendingMessage(sessionId, localId!);
        (await replayPersistedPendingOutboxForSession(sessionId, testOutboxScope));
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId, pendingOutboxOperation: 'cancel' }),
        ]);

        releaseRequest();
        const [enqueueResult] = await Promise.all([enqueuePromise, deletePromise]);

        expect(enqueueResult).toEqual({
            localId,
            accepted: true,
            cancelled: true,
        });

        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
        expect(requestCalls).toEqual([
            { path: `/v2/sessions/${sessionId}/pending`, method: 'POST' },
            { path: `/v2/sessions/${sessionId}/pending/${localId}`, method: 'DELETE' },
        ]);
    });

    it('suppresses a queued POST when remove becomes durable before that operation starts', async () => {
        const sessionId = 's_test_delete_before_post';
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);

        let releaseFirstPost!: () => void;
        const firstPostGate = new Promise<void>((resolve) => {
            releaseFirstPost = resolve;
        });
        let firstPostStarted!: () => void;
        const firstPostStartedGate = new Promise<void>((resolve) => {
            firstPostStarted = resolve;
        });
        const requestCalls: Array<{ path: string; method: string | undefined }> = [];
        const request = async (path: string, init?: RequestInit) => {
            requestCalls.push({ path, method: init?.method });
            if (init?.method === 'POST' && path.endsWith('/pending')) {
                firstPostStarted();
                await firstPostGate;
            }
            return init?.method === 'POST'
                ? acknowledgedEnqueueResponseForRequest(init)
                : acknowledgedEnqueueResponse();
        };

        const firstEnqueue = enqueuePendingMessageV2({
            sessionId,
            localId: 'first-local',
            text: 'first',
            encryption: { getSessionEncryption: () => null } as unknown as Encryption,
            request,
        });
        await firstPostStartedGate;

        (await persistLocalPending({ sessionId, localId: 'second-local', text: 'second', scope: testOutboxScope }));
        const queuedRetry = retryPendingOutboxOperationV2({
            sessionId,
            localId: 'second-local',
            request,
            outboxScope: testOutboxScope,
        });
        const remove = deletePendingMessageV2({ sessionId, pendingId: 'second-local', request });

        await vi.waitFor(async () => expect(await loadPendingOutboxForSession(sessionId, testOutboxScope)).toEqual(expect.arrayContaining([
            expect.objectContaining({ localId: 'second-local', operation: 'cancel' }),
        ])));

        releaseFirstPost();
        await Promise.all([firstEnqueue, queuedRetry, remove]);

        expect(requestCalls.filter((call) => call.method === 'POST')).toEqual([
            { path: `/v2/sessions/${sessionId}/pending`, method: 'POST' },
        ]);
        expect(requestCalls).toContainEqual({
            path: `/v2/sessions/${sessionId}/pending/second-local`,
            method: 'DELETE',
        });
    });

    it('keeps remove authoritative when an empty refresh lands before the first envelope is persisted', async () => {
        const sessionId = 's_test_delete_during_encryption';
        storage.getState().applySessions([buildSession({ sessionId })]);

        let encryptionStarted!: () => void;
        const encryptionStartedGate = new Promise<void>((resolve) => {
            encryptionStarted = resolve;
        });
        let releaseEncryption!: () => void;
        const encryptionGate = new Promise<void>((resolve) => {
            releaseEncryption = resolve;
        });
        const encryption = {
            getSessionEncryption: () => ({
                encryptRawRecord: async () => {
                    encryptionStarted();
                    await encryptionGate;
                    return 'cipher-after-remove';
                },
                decryptRaw: async () => null,
            }),
        } as unknown as Encryption;
        const requestCalls: Array<{ path: string; method: string | undefined }> = [];
        const request = async (path: string, init?: RequestInit) => {
            requestCalls.push({ path, method: init?.method });
            if (init?.method === 'GET') {
                return new Response(JSON.stringify({ pending: [] }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            return new Response(null, { status: 200 });
        };

        const enqueuePromise = enqueuePendingMessageV2({
            sessionId,
            localId: 'encrypting-local',
            text: 'remove before persistence',
            encryption,
            request,
        });
        await encryptionStartedGate;
        const removePromise = deletePendingMessageV2({
            sessionId,
            pendingId: 'encrypting-local',
            request,
        });
        expect((await loadPendingOutboxForSession(sessionId, testOutboxScope))).toEqual([]);

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request,
            outboxScope: testOutboxScope,
        });
        releaseEncryption();
        await Promise.all([enqueuePromise, removePromise]);

        expect(requestCalls.filter((call) => call.method === 'POST')).toEqual([]);
        expect(requestCalls).toContainEqual({
            path: `/v2/sessions/${sessionId}/pending/encrypting-local`,
            method: 'DELETE',
        });

    });

    it('cancels the exact scoped projection before persistence despite an earlier unscoped raw-id collision', async () => {
        const sessionId = 's_test_delete_exact_scope_before_persistence';
        const localId = 'encrypting-exact-scope-local';
        storage.getState().applySessions([buildSession({ sessionId })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId,
            localId: 'unrelated-unscoped-local',
            createdAt: 1,
            updatedAt: 1,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            pendingDeliveryStatus: 'server_queued',
            text: 'unrelated raw-id collision',
            rawRecord: { role: 'user', content: { type: 'text', text: 'unrelated raw-id collision' }, meta: {} },
        });

        let encryptionStarted!: () => void;
        const encryptionStartedGate = new Promise<void>((resolve) => { encryptionStarted = resolve; });
        let releaseEncryption!: () => void;
        const encryptionGate = new Promise<void>((resolve) => { releaseEncryption = resolve; });
        const encryption = {
            getSessionEncryption: () => ({
                encryptRawRecord: async () => {
                    encryptionStarted();
                    await encryptionGate;
                    return 'cipher-after-scoped-cancel';
                },
                decryptRaw: async () => null,
            }),
        } as unknown as Encryption;
        const requests: Array<{ path: string; method: string | undefined }> = [];
        const request = async (path: string, init?: RequestInit) => {
            requests.push({ path, method: init?.method });
            if (init?.method === 'POST') return acknowledgedEnqueueResponseForRequest(init);
            return new Response(null, { status: 404 });
        };

        const enqueue = enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'cancel exact scoped projection',
            encryption,
            request,
        });
        await encryptionStartedGate;
        expect((await loadPendingOutboxForSession(sessionId, testOutboxScope))).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ id: localId, localId: 'unrelated-unscoped-local' }),
            expect.objectContaining({
                localId,
                source: 'local_outbound',
                pendingOutboxScope: testOutboxScope,
            }),
        ]);

        const cancellation = deletePendingMessageV2({ sessionId, pendingId: localId, request });
        releaseEncryption();

        await expect(Promise.all([enqueue, cancellation])).resolves.toEqual([
            { localId, accepted: true, cancelled: true },
            undefined,
        ]);
        expect(requests).toEqual([{
            path: `/v2/sessions/${sessionId}/pending/${localId}`,
            method: 'DELETE',
        }]);
    });

    it('keeps exact-scope cancellation visible when refresh wins before persistence and DELETE fails', async () => {
        const sessionId = 's_test_delete_during_encryption_failure';
        const localId = 'encrypting-delete-failure-local';
        storage.getState().applySessions([buildSession({ sessionId })]);

        let encryptionStarted!: () => void;
        const encryptionStartedGate = new Promise<void>((resolve) => { encryptionStarted = resolve; });
        let releaseEncryption!: () => void;
        const encryptionGate = new Promise<void>((resolve) => { releaseEncryption = resolve; });
        const encryption = {
            getSessionEncryption: () => ({
                encryptRawRecord: async () => {
                    encryptionStarted();
                    await encryptionGate;
                    return 'cipher-after-failed-remove';
                },
                decryptRaw: async () => null,
            }),
        } as unknown as Encryption;
        const request = async (_path: string, init?: RequestInit) => {
            if (init?.method === 'GET') {
                return Response.json({ pending: [] });
            }
            if (init?.method === 'DELETE') {
                throw new TypeError('Failed to fetch');
            }
            return acknowledgedEnqueueResponseForRequest(init);
        };

        const enqueue = enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'keep failed cancellation visible',
            encryption,
            request,
        });
        await encryptionStartedGate;
        const cancellation = deletePendingMessageV2({ sessionId, pendingId: localId, request });
        const cancellationSettled = cancellation.catch(() => undefined);

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            request,
            outboxScope: testOutboxScope,
            isOutboxScopeCurrent: () => true,
        });
        const projectionDuringCancellation = storage.getState().sessionPending[sessionId]?.messages ?? [];

        releaseEncryption();
        await enqueue;
        await cancellationSettled;

        expect(projectionDuringCancellation).toEqual([
            expect.objectContaining({
                localId,
                source: 'local_outbound',
                pendingOutboxOperation: 'cancel',
            }),
        ]);
        await expect(cancellation).rejects.toThrow('Failed to fetch');
        expect((await loadPendingOutboxForSession(sessionId, testOutboxScope))).toEqual([
            expect.objectContaining({ localId, operation: 'cancel' }),
        ]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                source: 'local_outbound',
                pendingOutboxOperation: 'cancel',
                sendState: 'failed',
            }),
        ]);
    });

    it('restores a fully mapped snapshot row when a concurrent DELETE fails', async () => {
        const sessionId = 's_test_failed_delete_restores_snapshot';
        const pendingId = 'failed-delete-row';
        storage.getState().applySessions([buildSession({ sessionId })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: pendingId,
            localId: pendingId,
            createdAt: 1,
            updatedAt: 1,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            text: 'old projection',
            rawRecord: { role: 'user', content: { type: 'text', text: 'old projection' }, meta: {} },
        });
        let releaseDelete!: () => void;
        const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
        const deletion = deletePendingMessageV2({
            sessionId,
            pendingId,
            request: async () => {
                await deleteGate;
                return new Response(null, { status: 500 });
            },
        });
        const deletionSettled = deletion.catch(() => undefined);
        let snapshotJsonRead!: () => void;
        const snapshotJsonReadGate = new Promise<void>((resolve) => { snapshotJsonRead = resolve; });
        const encryption = {
            getSessionEncryption: () => ({
                decryptRaw: async () => {
                    await deletionSettled;
                    return { role: 'user', content: { type: 'text', text: 'authoritative server row' }, meta: {} };
                },
            }),
        };
        const refresh = fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: testOutboxScope,
            isOutboxScopeCurrent: () => true,
            request: async () => ({
                ok: true,
                status: 200,
                json: async () => {
                    snapshotJsonRead();
                    return {
                        pending: [{
                            localId: pendingId,
                            content: { t: 'encrypted', c: 'ciphertext' },
                            status: 'queued',
                            position: 0,
                            createdAt: 2,
                            updatedAt: 2,
                        }],
                    };
                },
            } as Response),
        });
        await snapshotJsonReadGate;
        for (let index = 0; index < 10; index += 1) {
            await Promise.resolve();
        }
        releaseDelete();

        await expect(deletion).rejects.toThrow('Failed to delete pending message (500)');
        await refresh;
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId: pendingId, text: 'authoritative server row' }),
        ]);
    });

    it('clears cancellation intent when encryption fails before the outbox row exists', async () => {
        const sessionId = 's_test_cancel_before_failed_encryption';
        const localId = 'failed-encryption-local';
        storage.getState().applySessions([buildSession({ sessionId })]);

        let encryptionStarted!: () => void;
        const encryptionStartedGate = new Promise<void>((resolve) => { encryptionStarted = resolve; });
        let releaseEncryption!: () => void;
        const encryptionGate = new Promise<void>((resolve) => { releaseEncryption = resolve; });
        const failingEncryption = {
            getSessionEncryption: () => ({
                encryptRawRecord: async () => {
                    encryptionStarted();
                    await encryptionGate;
                    throw new Error('encryption failed before persistence');
                },
                decryptRaw: async () => null,
            }),
        } as unknown as Encryption;
        const requests: Array<{ path: string; method: string | undefined }> = [];
        const request = async (path: string, init?: RequestInit) => {
            requests.push({ path, method: init?.method });
            return init?.method === 'POST'
                ? acknowledgedEnqueueResponseForRequest(init)
                : Response.json({ requestedAction: { v: 1, kind: 'enqueue' } });
        };

        const enqueue = enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'will fail before persistence',
            encryption: failingEncryption,
            request,
        });
        await encryptionStartedGate;
        const cancellation = deletePendingMessageV2({ sessionId, pendingId: localId, request });
        releaseEncryption();
        await expect(enqueue).rejects.toThrow('encryption failed before persistence');
        await expect(cancellation).resolves.toBeUndefined();

        await enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'reuse after failed persistence',
            encryption: await createPendingQueueEncryption({ sessionId, seedByte: 19 }),
            request,
        });
        expect(requests.filter((call) => call.method === 'POST')).toEqual([
            { path: `/v2/sessions/${sessionId}/pending`, method: 'POST' },
        ]);
    });

    it('keeps an authoritative server row visible while DELETE is unconfirmed and after DELETE fails', async () => {
        const sessionId = 's_test_unconfirmed_delete_visibility';
        const localId = 'unconfirmed-delete-local';
        storage.getState().applySessions([buildSession({
            sessionId,
            overrides: { encryptionMode: 'plain' },
        })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId,
            localId,
            createdAt: 1,
            updatedAt: 1,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            text: 'existing server row',
            rawRecord: { role: 'user', content: { type: 'text', text: 'existing server row' }, meta: {} },
        });

        let releaseDelete!: () => void;
        const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
        const deletion = deletePendingMessageV2({
            sessionId,
            pendingId: localId,
            request: async () => {
                await deleteGate;
                return new Response(null, { status: 500 });
            },
        });
        const deletionSettled = deletion.catch(() => undefined);

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: { getSessionEncryption: () => null },
            outboxScope: testOutboxScope,
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({
                pending: [{
                    localId,
                    content: {
                        t: 'plain',
                        v: { role: 'user', content: { type: 'text', text: 'authoritative server row' }, meta: {} },
                    },
                    messageRole: 'user',
                    requestedAction: { v: 1, kind: 'enqueue' },
                    status: 'queued',
                    position: 0,
                    createdAt: 2,
                    updatedAt: 2,
                    discardedAt: null,
                    discardedReason: null,
                }],
            }),
        });
        const visibleWhileDeleteIsUnconfirmed = storage.getState().sessionPending[sessionId]?.messages ?? [];

        releaseDelete();
        await deletionSettled;

        expect(visibleWhileDeleteIsUnconfirmed).toEqual([
            expect.objectContaining({ localId, text: 'authoritative server row' }),
        ]);
        await expect(deletion).rejects.toThrow('Failed to delete pending message (500)');
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId, text: 'authoritative server row' }),
        ]);
    });

    it('retains the confirmed-deletion fence when an absence snapshot lands before DELETE succeeds', async () => {
        const sessionId = 's_test_delete_fence_after_early_absence';
        const localId = 'delete-fence-local';
        storage.getState().applySessions([buildSession({
            sessionId,
            overrides: { encryptionMode: 'plain' },
        })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId,
            localId,
            createdAt: 1,
            updatedAt: 1,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            text: 'existing server row',
            rawRecord: { role: 'user', content: { type: 'text', text: 'existing server row' }, meta: {} },
        });

        let releaseDelete!: () => void;
        const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
        const deletion = deletePendingMessageV2({
            sessionId,
            pendingId: localId,
            request: async () => {
                await deleteGate;
                return new Response(null, { status: 200 });
            },
        });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: { getSessionEncryption: () => null },
            outboxScope: testOutboxScope,
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({ pending: [] }),
        });
        releaseDelete();
        await deletion;

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: { getSessionEncryption: () => null },
            outboxScope: testOutboxScope,
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({
                pending: [{
                    localId,
                    content: {
                        t: 'plain',
                        v: { role: 'user', content: { type: 'text', text: 'stale server row' }, meta: {} },
                    },
                    messageRole: 'user',
                    requestedAction: { v: 1, kind: 'enqueue' },
                    status: 'queued',
                    position: 0,
                    createdAt: 1,
                    updatedAt: 1,
                    discardedAt: null,
                    discardedReason: null,
                }],
            }),
        });

        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });

    it('does not downgrade an enqueue-owned confirmed cancellation when the queued delete rejoins', async () => {
        const sessionId = 's_test_serialized_cancel_fence';
        const localId = 'serialized-cancel-local';
        storage.getState().applySessions([buildSession({
            sessionId,
            overrides: { encryptionMode: 'plain' },
        })]);

        let postStarted!: () => void;
        const postStartedGate = new Promise<void>((resolve) => { postStarted = resolve; });
        let releasePost!: () => void;
        const postGate = new Promise<void>((resolve) => { releasePost = resolve; });
        const request = async (_path: string, init?: RequestInit) => {
            if (init?.method === 'POST') {
                postStarted();
                await postGate;
                return acknowledgedEnqueueResponseForRequest(init);
            }
            return new Response(null, { status: 200 });
        };

        const enqueue = enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'cancel while enqueue is committing',
            encryption: { getSessionEncryption: () => null } as unknown as Encryption,
            request,
        });
        await postStartedGate;
        const cancellation = deletePendingMessageV2({ sessionId, pendingId: localId, request });
        releasePost();
        await Promise.all([enqueue, cancellation]);

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: { getSessionEncryption: () => null },
            outboxScope: testOutboxScope,
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({
                pending: [{
                    localId,
                    content: {
                        t: 'plain',
                        v: { role: 'user', content: { type: 'text', text: 'stale server row' }, meta: {} },
                    },
                    messageRole: 'user',
                    requestedAction: { v: 1, kind: 'enqueue' },
                    status: 'queued',
                    position: 0,
                    createdAt: 1,
                    updatedAt: 1,
                    discardedAt: null,
                    discardedReason: null,
                }],
            }),
        });

        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });

    it('keeps a successful concurrent DELETE fenced when a sibling DELETE fails', async () => {
        const sessionId = 's_test_concurrent_delete_fence';
        const localId = 'concurrent-delete-local';
        storage.getState().applySessions([buildSession({
            sessionId,
            overrides: { encryptionMode: 'plain' },
        })]);
        storage.getState().upsertPendingMessage(sessionId, {
            id: localId,
            localId,
            createdAt: 1,
            updatedAt: 1,
            source: 'server_pending',
            deliveryStatus: 'accepted',
            text: 'existing server row',
            rawRecord: { role: 'user', content: { type: 'text', text: 'existing server row' }, meta: {} },
        });

        let releaseSuccessfulDelete!: () => void;
        const successfulDeleteGate = new Promise<void>((resolve) => { releaseSuccessfulDelete = resolve; });
        let releaseFailedDelete!: () => void;
        const failedDeleteGate = new Promise<void>((resolve) => { releaseFailedDelete = resolve; });
        const successfulDelete = deletePendingMessageV2({
            sessionId,
            pendingId: localId,
            request: async () => {
                await successfulDeleteGate;
                return new Response(null, { status: 200 });
            },
        });
        const failedDelete = deletePendingMessageV2({
            sessionId,
            pendingId: localId,
            request: async () => {
                await failedDeleteGate;
                return new Response(null, { status: 500 });
            },
        });

        releaseSuccessfulDelete();
        await successfulDelete;
        releaseFailedDelete();
        await expect(failedDelete).rejects.toThrow('Failed to delete pending message (500)');

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: { getSessionEncryption: () => null },
            outboxScope: testOutboxScope,
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({
                pending: [{
                    localId,
                    content: {
                        t: 'plain',
                        v: { role: 'user', content: { type: 'text', text: 'stale server row' }, meta: {} },
                    },
                    messageRole: 'user',
                    requestedAction: { v: 1, kind: 'enqueue' },
                    status: 'queued',
                    position: 0,
                    createdAt: 1,
                    updatedAt: 1,
                    discardedAt: null,
                    discardedReason: null,
                }],
            }),
        });

        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });

    it('does not apply a server snapshot captured before a confirmed deletion', async () => {
        const sessionId = 's_test_stale_snapshot_after_delete';
        const localId = 'stale-delete-local';
        storage.getState().applySessions([buildSession({ sessionId })]);
        let decryptStarted!: () => void;
        const decryptStartedGate = new Promise<void>((resolve) => { decryptStarted = resolve; });
        let releaseDecrypt!: () => void;
        const decryptGate = new Promise<void>((resolve) => { releaseDecrypt = resolve; });
        const encryption = {
            getSessionEncryption: () => ({
                encryptRawRecord: async () => 'unused',
                decryptRaw: async () => {
                    decryptStarted();
                    await decryptGate;
                    return { role: 'user', content: { type: 'text', text: 'stale snapshot' }, meta: {} };
                },
            }),
        } as unknown as Encryption;
        const refresh = fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: testOutboxScope,
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({
                pending: [{
                    localId,
                    content: { t: 'encrypted', c: 'cipher-before-delete' },
                    messageRole: 'user',
                    requestedAction: { v: 1, kind: 'enqueue' },
                    status: 'queued',
                    position: 0,
                    createdAt: 111,
                    updatedAt: 111,
                    discardedAt: null,
                    discardedReason: null,
                }],
            }),
        });
        await decryptStartedGate;
        await deletePendingMessageV2({
            sessionId,
            pendingId: localId,
            request: async () => new Response(null, { status: 200 }),
        });
        releaseDecrypt();
        await refresh;

        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });

    it('does not resurrect a discarded row captured before its confirmed deletion', async () => {
        const sessionId = 's_test_stale_discarded_snapshot_after_delete';
        const localId = 'stale-discarded-local';
        storage.getState().applySessions([buildSession({ sessionId })]);
        let decryptStarted!: () => void;
        const decryptStartedGate = new Promise<void>((resolve) => { decryptStarted = resolve; });
        let releaseDecrypt!: () => void;
        const decryptGate = new Promise<void>((resolve) => { releaseDecrypt = resolve; });
        const encryption = {
            getSessionEncryption: () => ({
                encryptRawRecord: async () => 'unused',
                decryptRaw: async () => {
                    decryptStarted();
                    await decryptGate;
                    return { role: 'user', content: { type: 'text', text: 'stale discarded' }, meta: {} };
                },
            }),
        } as unknown as Encryption;
        const staleRefresh = fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: testOutboxScope,
            isOutboxScopeCurrent: () => true,
            request: async () => Response.json({
                pending: [{
                    localId,
                    content: { t: 'encrypted', c: 'discarded-cipher-before-delete' },
                    messageRole: 'user',
                    requestedAction: { v: 1, kind: 'enqueue' },
                    status: 'discarded',
                    position: 0,
                    createdAt: 111,
                    updatedAt: 112,
                    discardedAt: 112,
                    discardedReason: 'manual',
                }],
            }),
        });
        await decryptStartedGate;
        await deleteDiscardedPendingMessageV2({
            sessionId,
            pendingId: localId,
            encryption,
            outboxScope: testOutboxScope,
            request: async (_path, init) => init?.method === 'DELETE'
                ? new Response(null, { status: 200 })
                : Response.json({ pending: [] }),
        });
        releaseDecrypt();
        await staleRefresh;

        expect(storage.getState().sessionPending[sessionId]?.discarded ?? []).toEqual([]);
    });

    it('reconciles the exact-scope durable projection to a colliding server refresh row', async () => {
        const sessionId = 's_test_scoped_refresh_collision';
        const localId = 'same-refresh-local';
        storage.getState().applySessions([buildSession({
            sessionId,
            overrides: { encryptionMode: 'plain' },
        })]);
        (await persistLocalPending({
            sessionId,
            localId,
            text: 'durable projection',
            scope: testOutboxScope,
        }));
        const encryption = await createPendingQueueEncryption({ sessionId });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: testOutboxScope,
            isOutboxScopeCurrent: () => true,
            request: async () => new Response(JSON.stringify({
                pending: [{
                    localId,
                    content: {
                        t: 'plain',
                        v: { role: 'user', content: { type: 'text', text: 'durable projection' }, meta: {} },
                    },
                    requestedAction: { v: 1, kind: 'enqueue' },
                    status: 'queued',
                    position: 0,
                    createdAt: 222,
                    updatedAt: 222,
                }],
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
        });

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                text: 'durable projection',
                source: 'server_pending',
            }),
        ]);
        expect((await loadPendingOutboxForSession(sessionId, testOutboxScope))).toEqual([]);
    });

    it('retains and replays a durable cancellation when the server snapshot is merely discarded', async () => {
        const sessionId = 's_test_scoped_discarded_collision';
        const localId = 'same-discarded-local';
        storage.getState().applySessions([buildSession({
            sessionId,
            overrides: { encryptionMode: 'plain' },
        })]);
        (await persistLocalPending({
            sessionId,
            localId,
            text: 'durable cancellation',
            scope: testOutboxScope,
            operation: 'cancel',
        }));
        const encryption = await createPendingQueueEncryption({ sessionId });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption,
            outboxScope: testOutboxScope,
            isOutboxScopeCurrent: () => true,
            request: async () => new Response(JSON.stringify({
                pending: [{
                    localId,
                    content: {
                        t: 'plain',
                        v: { role: 'user', content: { type: 'text', text: 'server discarded row' }, meta: {} },
                    },
                    requestedAction: { v: 1, kind: 'enqueue' },
                    status: 'discarded',
                    position: 0,
                    createdAt: 222,
                    updatedAt: 223,
                    discardedAt: 223,
                    discardedReason: 'manual',
                }],
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
        });

        expect(storage.getState().sessionPending[sessionId]).toEqual(expect.objectContaining({
            messages: [],
            discarded: [expect.objectContaining({ localId, source: 'server_pending', text: 'server discarded row' })],
        }));
        expect((await loadPendingOutboxForSession(sessionId, testOutboxScope))).toEqual([
            expect.objectContaining({ localId, operation: 'cancel' }),
        ]);
        expect((await replayPersistedPendingOutboxForSession(sessionId, testOutboxScope))).toEqual([localId]);
        expect((await loadPendingOutboxForSession(sessionId, testOutboxScope))).toEqual([
            expect.objectContaining({ localId, operation: 'cancel' }),
        ]);

        const requests: Array<{ path: string; method: string | undefined }> = [];
        await retryPendingOutboxOperationV2({
            sessionId,
            localId,
            outboxScope: testOutboxScope,
            request: async (path, init) => {
                requests.push({ path, method: init?.method });
                return new Response(null, { status: 204 });
            },
        });
        expect(requests).toEqual([{
            path: `/v2/sessions/${sessionId}/pending/${localId}`,
            method: 'DELETE',
        }]);
        expect((await loadPendingOutboxForSession(sessionId, testOutboxScope))).toEqual([]);
    });

    it('follows an ambiguously committed held POST with DELETE and retains cancel until confirmation', async () => {
        const sessionId = 's_test_ambiguous_post_then_delete';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 14 });

        let postStarted!: () => void;
        const postStartedGate = new Promise<void>((resolve) => {
            postStarted = resolve;
        });
        let releasePost!: () => void;
        const postGate = new Promise<void>((resolve) => {
            releasePost = resolve;
        });
        const requestCalls: Array<{ path: string; method: string | undefined }> = [];
        const request = async (path: string, init?: RequestInit) => {
            requestCalls.push({ path, method: init?.method });
            if (init?.method === 'POST') {
                postStarted();
                await postGate;
                throw new TypeError('response lost after commit');
            }
            return new Response(null, { status: 404 });
        };

        const enqueuePromise = enqueuePendingMessageV2({
            sessionId,
            localId: 'ambiguous-local',
            text: 'possibly committed',
            encryption,
            request,
        });
        await postStartedGate;
        const removePromise = deletePendingMessageV2({
            sessionId,
            pendingId: 'ambiguous-local',
            request,
        });
        await vi.waitFor(async () => expect(await loadPendingOutboxForSession(sessionId, testOutboxScope)).toEqual([
            expect.objectContaining({ localId: 'ambiguous-local', operation: 'cancel' }),
        ]));

        releasePost();
        await expect(enqueuePromise).resolves.toEqual({ localId: 'ambiguous-local', accepted: false });
        await expect(removePromise).resolves.toBeUndefined();
        expect(requestCalls).toEqual([
            { path: `/v2/sessions/${sessionId}/pending`, method: 'POST' },
            { path: `/v2/sessions/${sessionId}/pending/ambiguous-local`, method: 'DELETE' },
        ]);
        expect((await loadPendingOutboxForSession(sessionId, testOutboxScope))).toEqual([]);
    });

    it('does not share operation ordering or cancellation across server-account scopes', async () => {
        const sessionId = 'same-session';
        const localId = 'same-local';
        const scopeA = { serverId: 'server-a', accountId: 'account-a' } as const;
        const scopeB = { serverId: 'server-b', accountId: 'account-b' } as const;
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        (await persistLocalPending({ sessionId, localId, text: 'cancel A', scope: scopeA }));

        let deleteAStarted!: () => void;
        const deleteAStartedGate = new Promise<void>((resolve) => {
            deleteAStarted = resolve;
        });
        let releaseDeleteA!: () => void;
        const deleteAGate = new Promise<void>((resolve) => {
            releaseDeleteA = resolve;
        });
        const deleteA = deletePendingMessageV2Impl({
            sessionId,
            pendingId: localId,
            outboxScope: scopeA,
            request: async (_path, init) => {
                if (init?.method === 'DELETE') {
                    deleteAStarted();
                    await deleteAGate;
                }
                return acknowledgedEnqueueResponse();
            },
        });
        await deleteAStartedGate;

        let scopeBPostCount = 0;
        const enqueueB = enqueuePendingMessageV2Impl({
            sessionId,
            localId,
            text: 'send B',
            encryption: { getSessionEncryption: () => null } as unknown as Encryption,
            outboxScope: scopeB,
            requestedAction: { v: 1, kind: 'enqueue' },
            wireMode: 'pending_input_v1',
            request: async (_path, init) => {
                if (init?.method === 'POST') scopeBPostCount += 1;
                return acknowledgedEnqueueResponseForRequest(init);
            },
        });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        await vi.waitFor(() => expect(scopeBPostCount).toBe(1));
        await enqueueB;
        expect((await loadPendingOutboxForSession(sessionId, scopeB))).toEqual([]);

        releaseDeleteA();
        await Promise.all([deleteA, enqueueB]);
    });

    it('does not remove another scope projection when scoped cancellation completes', async () => {
        const sessionId = 'same-session-cancel-projection';
        const localId = 'same-local-cancel-projection';
        const scopeA = { serverId: 'server-a', accountId: 'account-a' } as const;
        const scopeB = { serverId: 'server-b', accountId: 'account-b' } as const;
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        (await persistLocalPending({ sessionId, localId, text: 'cancel A', scope: scopeA }));

        let deleteStarted!: () => void;
        const deleteStartedGate = new Promise<void>((resolve) => { deleteStarted = resolve; });
        let releaseDelete!: () => void;
        const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
        const cancellation = deletePendingMessageV2Impl({
            sessionId,
            pendingId: localId,
            outboxScope: scopeA,
            request: async (_path, init) => {
                if (init?.method === 'DELETE') {
                    deleteStarted();
                    await deleteGate;
                }
                return new Response(null, { status: 200 });
            },
        });
        await deleteStartedGate;

        (await persistLocalPending({ sessionId, localId, text: 'keep B', scope: scopeB }));
        releaseDelete();
        await cancellation;

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId, text: 'keep B', pendingOutboxScope: scopeB }),
        ]);
        expect((await loadPendingOutboxForSession(sessionId, scopeB))).toEqual([
            expect.objectContaining({ localId, text: 'keep B', operation: 'enqueue' }),
        ]);
    });

    it('does not start cancellation from a colliding projection owned by another scope', async () => {
        const sessionId = 'same-session-cancel-entry';
        const localId = 'same-local-cancel-entry';
        const scopeA = { serverId: 'server-a', accountId: 'account-a' } as const;
        const scopeB = { serverId: 'server-b', accountId: 'account-b' } as const;
        (await persistLocalPending({ sessionId, localId, text: 'keep B', scope: scopeB }));
        const request = vi.fn(async () => new Response(null, { status: 200 }));

        await deletePendingMessageV2Impl({
            sessionId,
            pendingId: localId,
            request,
            outboxScope: scopeA,
        });

        expect(request).not.toHaveBeenCalled();
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId, text: 'keep B', pendingOutboxScope: scopeB }),
        ]);
        expect((await loadPendingOutboxForSession(sessionId, scopeB))).toHaveLength(1);
    });

    it('does not replace another scope projection when scoped enqueue is accepted', async () => {
        const sessionId = 'same-session-accept-projection';
        const localId = 'same-local-accept-projection';
        const scopeA = { serverId: 'server-a', accountId: 'account-a' } as const;
        const scopeB = { serverId: 'server-b', accountId: 'account-b' } as const;
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);

        let postStarted!: () => void;
        const postStartedGate = new Promise<void>((resolve) => { postStarted = resolve; });
        let releasePost!: () => void;
        const postGate = new Promise<void>((resolve) => { releasePost = resolve; });
        const enqueueA = enqueuePendingMessageV2Impl({
            sessionId,
            localId,
            text: 'accept A',
            encryption: { getSessionEncryption: () => null } as unknown as Encryption,
            outboxScope: scopeA,
            requestedAction: { v: 1, kind: 'enqueue' },
            wireMode: 'pending_input_v1',
            request: async (_path, init) => {
                if (init?.method === 'POST') {
                    postStarted();
                    await postGate;
                }
                return acknowledgedEnqueueResponseForRequest(init);
            },
        });
        await postStartedGate;

        (await persistLocalPending({ sessionId, localId, text: 'keep B', scope: scopeB }));
        releasePost();
        await enqueueA;

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId, text: 'keep B', pendingOutboxScope: scopeB }),
        ]);
        expect((await loadPendingOutboxForSession(sessionId, scopeB))).toEqual([
            expect.objectContaining({ localId, text: 'keep B', operation: 'enqueue' }),
        ]);
    });

    it('keeps queued pending messages in call order even when earlier encryption resolves later', async () => {
        const sessionId = 's_test_enqueue_order';
        storage.getState().applySessions([buildSession({ sessionId })]);

        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = () => resolve();
        });

        const requestCiphertexts: string[] = [];
        const encryption = {
            getSessionEncryption: () =>
                ({
                    encryptRawRecord: async (rawRecord: any) => {
                        const text = rawRecord?.content?.text;
                        if (text === 'first') {
                            await firstGate;
                        }
                        return `cipher-${String(text)}`;
                    },
                }) as unknown as ReturnType<Encryption['getSessionEncryption']>,
        } as unknown as Encryption;

        const request = async (_path: string, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body ?? 'null')) as any;
            requestCiphertexts.push(String(body?.ciphertext ?? ''));
            return acknowledgedEnqueueResponseForRequest(init);
        };

        const promiseFirst = enqueuePendingMessageV2({
            sessionId,
            text: 'first',
            encryption,
            request,
        });
        const promiseSecond = enqueuePendingMessageV2({
            sessionId,
            text: 'second',
            encryption,
            request,
        });

        releaseFirst();

        await Promise.all([promiseFirst, promiseSecond]);

        const pending = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(pending.map((m) => m.text)).toEqual(['first', 'second']);
        expect(requestCiphertexts).toEqual(['cipher-first', 'cipher-second']);
    });

    it('coalesces concurrent enqueues that share one explicit local ID', async () => {
        const sessionId = 's_test_concurrent_same_local_id';
        const localId = 'same-explicit-local';
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        const bodies: unknown[] = [];
        let firstPostStarted!: () => void;
        const firstPostStartedGate = new Promise<void>((resolve) => { firstPostStarted = resolve; });
        let releaseFirstPost!: () => void;
        const firstPostGate = new Promise<void>((resolve) => { releaseFirstPost = resolve; });
        const request = async (_path: string, init?: RequestInit) => {
            bodies.push(JSON.parse(String(init?.body ?? 'null')));
            if (bodies.length === 1) {
                firstPostStarted();
                await firstPostGate;
            }
            return acknowledgedEnqueueResponseForRequest(init);
        };
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 23 });

        const first = enqueuePendingMessageV2({ sessionId, localId, text: 'first identity owner', encryption, request });
        const second = enqueuePendingMessageV2({ sessionId, localId, text: 'must rejoin first', encryption, request });
        await firstPostStartedGate;
        releaseFirstPost();
        await Promise.all([first, second]);

        expect(bodies).toHaveLength(1);
        expect(bodies[0]).toEqual(expect.objectContaining({
            localId,
            content: expect.objectContaining({
                t: 'plain',
                v: expect.objectContaining({ content: expect.objectContaining({ text: 'first identity owner' }) }),
            }),
        }));
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId, text: 'first identity owner' }),
        ]);
    });

    it('does not prune cancellation while the exact enqueue is in flight before outbox persistence', async () => {
        const sessionId = 's_test_cancel_before_outbox_persistence';
        const localId = 'cancel-before-outbox-persistence';
        storage.getState().applySessions([buildSession({ sessionId })]);
        let encryptionStarted!: () => void;
        const encryptionStartedGate = new Promise<void>((resolve) => { encryptionStarted = resolve; });
        let releaseEncryption!: () => void;
        const encryptionGate = new Promise<void>((resolve) => { releaseEncryption = resolve; });
        const encryption = {
            getSessionEncryption: async () => {
                encryptionStarted();
                await encryptionGate;
                return { encryptRawRecord: async () => 'ciphertext' };
            },
        } as unknown as Encryption;
        const requests: string[] = [];
        const request = async (path: string, init?: RequestInit) => {
            requests.push(`${init?.method ?? 'GET'} ${path}`);
            return init?.method === 'DELETE'
                ? new Response(null, { status: 200 })
                : acknowledgedEnqueueResponseForRequest(init);
        };

        const enqueue = enqueuePendingMessageV2({ sessionId, localId, text: 'cancel me', encryption, request });
        await encryptionStartedGate;
        const cancellation = deletePendingMessageV2({ sessionId, pendingId: localId, request });

        await fetchAndApplyPendingMessagesV2({
            sessionId,
            outboxScope: testOutboxScope,
            isOutboxScopeCurrent: () => true,
            encryption: { getSessionEncryption: () => null },
            request: async () => Response.json({ pending: [] }),
        });
        releaseEncryption();

        await expect(enqueue).resolves.toEqual({ localId, accepted: true, cancelled: true });
        await expect(cancellation).resolves.toBeUndefined();
        expect(requests).toEqual([
            `DELETE /v2/sessions/${sessionId}/pending/${localId}`,
        ]);
        expect((await loadPendingOutboxForSession(sessionId, testOutboxScope))).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });

    it('invalidates an older in-flight snapshot before retiring confirmed outbox custody', async () => {
        const sessionId = 's_test_confirm_invalidates_snapshot';
        const localId = 'confirmed-after-snapshot-start';
        storage.getState().applySessions([buildSession({ sessionId })]);
        let decryptStarted!: () => void;
        const decryptStartedGate = new Promise<void>((resolve) => { decryptStarted = resolve; });
        let releaseDecrypt!: () => void;
        const decryptGate = new Promise<void>((resolve) => { releaseDecrypt = resolve; });
        const staleRefresh = fetchAndApplyPendingMessagesV2({
            sessionId,
            outboxScope: testOutboxScope,
            isOutboxScopeCurrent: () => true,
            encryption: {
                getSessionEncryption: () => ({
                    decryptRaw: async () => {
                        decryptStarted();
                        await decryptGate;
                        return { role: 'user', content: { type: 'text', text: 'stale server row' }, meta: {} };
                    },
                }),
            },
            request: async () => Response.json({
                pending: [{
                    localId: 'stale-server-local',
                    content: { t: 'encrypted', c: 'stale-ciphertext' },
                    messageRole: 'user',
                    requestedAction: { v: 1, kind: 'enqueue' },
                    status: 'queued',
                    position: 0,
                    createdAt: 10,
                    updatedAt: 10,
                    discardedAt: null,
                    discardedReason: null,
                }],
            }),
        });
        await decryptStartedGate;

        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 24 });
        await enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'confirmed local row',
            encryption,
            request: async () => acknowledgedEnqueueResponse({ pending: { localId } }),
        });
        releaseDecrypt();
        await staleRefresh;

        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({ localId, source: 'local_outbound', deliveryStatus: 'accepted' }),
        ]);
    });

    it('clears optimistic thinking when encryption fails', async () => {
        const sessionId = 's_test_encrypt_fail';
        storage.getState().applySessions([buildSession({ sessionId })]);

        const encryption = {
            getSessionEncryption: () =>
                ({
                    encryptRawRecord: async () => {
                        throw new Error('encrypt-failed');
                    },
                }) as unknown as ReturnType<Encryption['getSessionEncryption']>,
        } as unknown as Encryption;

        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();

        const promise = enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption,
            request: async () => acknowledgedEnqueueResponse(),
        }).catch(() => null);

        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).not.toBeNull();

        await promise;

        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
    });

    it('includes provider-specific message meta extras for queued sends', async () => {
        const sessionId = 's_test_provider_meta';
        storage.getState().applySessions([
            {
                ...buildSession({ sessionId }),
                metadata: { path: '/tmp', host: 'h', flavor: 'claude' } as Session['metadata'],
            },
        ]);
        storage.setState(
            {
                ...storage.getState(),
                settings: settingsParse({
                    claudeRemoteAgentSdkEnabled: true,
                    claudeRemoteSettingSourcesV2: ['project'],
                }),
            },
            true,
        );

        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 7 });

        await enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption,
            request: async (_path, init) => acknowledgedEnqueueResponseForRequest(init),
        });

        const pending = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(pending.length).toBe(1);
        const metadata = pending[0]?.rawRecord?.meta as Record<string, unknown> | undefined;
        expect(metadata?.claudeRemoteAgentSdkEnabled).toBe(true);
        expect(metadata?.claudeRemoteSettingSources).toBe('project');
        expect(metadata?.claudeRemoteSettingSourcesV2).toEqual(['project']);
    });

    it('includes metaOverrides (e.g. meta.happier) for queued sends', async () => {
        const sessionId = 's_test_meta_overrides';
        storage.getState().applySessions([buildSession({ sessionId })]);

        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 7 });

        await enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption,
            metaOverrides: {
                happier: {
                    kind: 'review_comments.v1',
                    payload: { sessionId, comments: [] },
                },
            },
            request: async (_path, init) => acknowledgedEnqueueResponseForRequest(init),
        });

        const pending = storage.getState().sessionPending[sessionId]?.messages ?? [];
        expect(pending.length).toBe(1);
        const metadata = pending[0]?.rawRecord?.meta as Record<string, unknown> | undefined;
        expect((metadata as any)?.happier?.kind).toBe('review_comments.v1');
    });

    it('removes queued pending message and clears optimistic thinking when enqueue request fails', async () => {
        const sessionId = 's_test_request_fail';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 8 });

        await expect(
            enqueuePendingMessageV2({
                sessionId,
                text: 'hello',
                encryption,
                request: async () => new Response(null, { status: 500 }),
            }),
        ).rejects.toThrow('Failed to enqueue pending message (500)');

        const pendingState = storage.getState().sessionPending[sessionId];
        expect(pendingState?.messages ?? []).toEqual([]);
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
    });

    it('retains a pre-existing ambiguous outbox row when its rejoined enqueue fails definitively', async () => {
        const sessionId = 's_test_rejoined_outbox_definitive_failure';
        const localId = 'rejoined-outbox-definitive-failure';
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        (await persistLocalPending({
            sessionId,
            localId,
            text: 'existing ambiguous custody',
            scope: testOutboxScope,
        }));
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 25 });

        await expect(enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'must use retained envelope',
            encryption,
            request: async () => new Response(null, { status: 500 }),
        })).rejects.toThrow('Failed to enqueue pending message (500)');

        expect((await loadPendingOutboxForSession(sessionId, testOutboxScope))).toEqual([
            expect.objectContaining({ localId, text: 'existing ambiguous custody', operation: 'enqueue' }),
        ]);
        expect(storage.getState().sessionPending[sessionId]?.messages).toEqual([
            expect.objectContaining({
                localId,
                source: 'local_outbound',
                sendState: 'unconfirmed',
                text: 'existing ambiguous custody',
            }),
        ]);
    });

    it('replays a valid frozen envelope when direct rejoin finds invalid auxiliary rawRecord', async () => {
        const sessionId = 's_test_direct_rejoin_invalid_auxiliary_projection';
        const localId = 'direct-rejoin-invalid-auxiliary-projection';
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        (await savePendingOutboxMessage({
            sessionId,
            localId,
            createdAt: 111,
            text: 'valid frozen envelope',
            // Boundary fixture deliberately persists malformed auxiliary projection data beside a valid frozen envelope.
            rawRecord: ({ role: 'assistant', content: { type: 'text', text: 'invalid auxiliary projection' } } as unknown as Parameters<typeof savePendingOutboxMessage>[0]['rawRecord']),
            request: {
                v: 1,
                body: plainPendingBody(localId, 'valid frozen envelope'),
            },
        }, testOutboxScope));
        (await replayPersistedPendingOutboxForSession(sessionId, testOutboxScope));
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 26 });
        const frozenBody = (await loadPendingOutboxForSession(sessionId, testOutboxScope))[0]!.request.body;
        const sentBodies: string[] = [];

        await expect(enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'must retain frozen custody',
            encryption,
            request: async (_path, init) => {
                sentBodies.push(String(init?.body ?? ''));
                return acknowledgedEnqueueResponseForRequest(init);
            },
        })).resolves.toEqual({ localId, accepted: true });

        expect(sentBodies).toEqual([frozenBody]);
        expect((await loadPendingOutboxForSession(sessionId, testOutboxScope))).toEqual([]);
        expect(storage.getState().sessionPending[sessionId]?.messages ?? []).toEqual([]);
    });

    it.each([401, 403] as const)('surfaces enqueue auth status %s as not_authenticated', async (status) => {
        const sessionId = `s_test_request_auth_${status}`;
        storage.getState().applySessions([buildSession({ sessionId })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 8 });

        await expect(
            enqueuePendingMessageV2({
                sessionId,
                text: 'hello',
                encryption,
                request: async () => new Response(null, { status }),
            }),
        ).rejects.toMatchObject({
            name: 'HappyError',
            canTryAgain: false,
            kind: 'auth',
            code: 'not_authenticated',
            status,
        });

        const pendingState = storage.getState().sessionPending[sessionId];
        expect(pendingState?.messages ?? []).toEqual([]);
        expect(storage.getState().sessions[sessionId].optimisticThinkingAt ?? null).toBeNull();
    });

    it('sends plaintext pending payloads when session encryptionMode is plain', async () => {
        const sessionId = 's_test_plain_send';
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);
        const encryption = await createPendingQueueEncryption({ sessionId, seedByte: 8 });

        const bodies: unknown[] = [];
        await enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption,
            request: async (_path, init) => {
                bodies.push(JSON.parse(String(init?.body ?? 'null')));
                return acknowledgedEnqueueResponseForRequest(init);
            },
        });

        expect(bodies).toHaveLength(1);
        expect(bodies[0]).toEqual(
            expect.objectContaining({
                localId: expect.any(String),
                content: expect.objectContaining({ t: 'plain', v: expect.any(Object) }),
                messageRole: 'user',
            }),
        );
        expect(bodies[0]).not.toEqual(expect.objectContaining({ ciphertext: expect.anything() }));
    });

    it('does not require a session encryption key when session encryptionMode is plain', async () => {
        const sessionId = 's_test_plain_send_no_key';
        storage.getState().applySessions([buildSession({ sessionId, overrides: { encryptionMode: 'plain' } })]);

        const bodies: unknown[] = [];
        const encryptionWithoutSessionKey = {
            getSessionEncryption: () => null,
        } as unknown as Encryption;
        await enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption: encryptionWithoutSessionKey,
            request: async (_path, init) => {
                bodies.push(JSON.parse(String(init?.body ?? 'null')));
                return acknowledgedEnqueueResponseForRequest(init);
            },
        });

        expect(bodies).toHaveLength(1);
        expect(bodies[0]).toEqual(
            expect.objectContaining({
                localId: expect.any(String),
                content: expect.objectContaining({ t: 'plain', v: expect.any(Object) }),
                messageRole: 'user',
            }),
        );
        expect(bodies[0]).not.toEqual(expect.objectContaining({ ciphertext: expect.anything() }));
    });
});
