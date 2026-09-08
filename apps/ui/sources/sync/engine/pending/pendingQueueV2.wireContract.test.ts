import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    loadPendingOutboxForSession,
    removePendingOutboxMessage,
} from '@/sync/domains/state/pendingOutboxPersistence';
import { storage } from '@/sync/domains/state/storage';

import {
    enqueuePendingMessageV2,
    retryPendingOutboxOperationV2,
    updatePendingRequestedActionV2,
} from './pendingQueueV2';
import { buildSession, createPendingQueueEncryption, resetPendingQueueState } from './pendingQueueV2.testHelpers';

const outboxScope = { serverId: 'server-a', accountId: 'account-a' } as const;

function releasedAck(localId: string): Response {
    return Response.json({
        didWrite: true,
        pending: {
            localId,
            content: {
                t: 'plain',
                v: { role: 'user', content: { type: 'text', text: 'hello' } },
            },
            status: 'queued',
            position: 1,
            createdAt: 100,
            updatedAt: 100,
            discardedAt: null,
            discardedReason: null,
            authorAccountId: 'account-a',
        },
        pendingCount: 1,
        pendingVersion: 1,
    });
}

describe('Pending queue HTTP wire contract', () => {
    beforeEach(() => {
        resetPendingQueueState();
    });

    it('emits only the immutable released ordinary enqueue shape and accepts its released ACK', async () => {
        const sessionId = 'session-released-wire';
        storage.getState().applySessions([buildSession({
            sessionId,
            overrides: { encryptionMode: 'plain' },
        })]);
        const encryption = await createPendingQueueEncryption({ sessionId });
        const request = vi.fn(async (_path: string, init?: RequestInit) => {
            expect(JSON.parse(String(init?.body))).toEqual({
                localId: 'local-released-wire',
                content: {
                    t: 'plain',
                    v: expect.objectContaining({
                        role: 'user',
                        content: { type: 'text', text: 'hello' },
                    }),
                },
            });
            return releasedAck('local-released-wire');
        });

        await expect(enqueuePendingMessageV2({
            sessionId,
            localId: 'local-released-wire',
            text: 'hello',
            encryption,
            request,
            outboxScope,
            wireMode: 'released_server_v0_2_1',
            requestedAction: { v: 1, kind: 'enqueue' },
        })).resolves.toMatchObject({ accepted: true, localId: 'local-released-wire' });
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('keeps durable outbox custody and performs no POST while the wire mode is indeterminate', async () => {
        const sessionId = 'session-indeterminate-wire';
        storage.getState().applySessions([buildSession({
            sessionId,
            overrides: { encryptionMode: 'plain' },
        })]);
        const encryption = await createPendingQueueEncryption({ sessionId });
        const request = vi.fn();

        await expect(enqueuePendingMessageV2({
            sessionId,
            localId: 'local-indeterminate-wire',
            text: 'hello',
            encryption,
            request,
            outboxScope,
            wireMode: 'indeterminate',
            requestedAction: { v: 1, kind: 'enqueue' },
        })).resolves.toEqual({
            accepted: false,
            localId: 'local-indeterminate-wire',
            waitingForWireMode: true,
        });
        expect(request).not.toHaveBeenCalled();
        expect((await loadPendingOutboxForSession(sessionId, outboxScope))).toEqual([
            expect.objectContaining({ localId: 'local-indeterminate-wire', operation: 'enqueue' }),
        ]);
    });

    it('keeps FIFO delivery while sending a separate resume authorization only on the v2 wire', async () => {
        const sessionId = 'session-resume-when-available';
        storage.getState().applySessions([buildSession({
            sessionId,
            overrides: { encryptionMode: 'plain' },
        })]);
        const encryption = await createPendingQueueEncryption({ sessionId });
        const request = vi.fn(async (_path: string, init?: RequestInit) => {
            expect(JSON.parse(String(init?.body))).toEqual(expect.objectContaining({
                localId: 'local-resume-when-available',
                requestedAction: { v: 1, kind: 'enqueue' },
                resumeWhenAvailable: true,
            }));
            return Response.json({
                requestedAction: { v: 1, kind: 'enqueue' },
                pending: { localId: 'local-resume-when-available' },
            });
        });

        await expect(enqueuePendingMessageV2({
            sessionId,
            localId: 'local-resume-when-available',
            text: 'hello',
            encryption,
            request,
            outboxScope,
            wireMode: 'pending_input_v2',
            requestedAction: { v: 1, kind: 'enqueue' },
            resumeWhenAvailable: true,
        })).resolves.toMatchObject({ accepted: true });
    });

    it('sends the separate resume authorization when retrying an existing row on v2', async () => {
        const request = vi.fn(async (_path: string, init?: RequestInit) => {
            expect(JSON.parse(String(init?.body))).toEqual({
                requestedAction: { v: 1, kind: 'enqueue' },
                resumeWhenAvailable: true,
            });
            return Response.json({ didUpdate: true });
        });

        await updatePendingRequestedActionV2({
            sessionId: 'session-resume-action',
            localId: 'local-resume-action',
            requestedAction: { v: 1, kind: 'enqueue' },
            resumeWhenAvailable: true,
            request,
            outboxScope,
            wireMode: 'pending_input_v2',
        });
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('drops the separate resume command when a durable enqueue is transported to a v1 server', async () => {
        const sessionId = 'session-resume-v1-enqueue';
        storage.getState().applySessions([buildSession({
            sessionId,
            overrides: { encryptionMode: 'plain' },
        })]);
        const encryption = await createPendingQueueEncryption({ sessionId });
        const request = vi.fn(async (_path: string, init?: RequestInit) => {
            expect(JSON.parse(String(init?.body))).toEqual(expect.objectContaining({
                localId: 'local-resume-v1-enqueue',
                requestedAction: { v: 1, kind: 'enqueue' },
            }));
            expect(JSON.parse(String(init?.body))).not.toHaveProperty('resumeWhenAvailable');
            return Response.json({
                requestedAction: { v: 1, kind: 'enqueue' },
                pending: { localId: 'local-resume-v1-enqueue' },
            });
        });

        await expect(enqueuePendingMessageV2({
            sessionId,
            localId: 'local-resume-v1-enqueue',
            text: 'hello',
            encryption,
            request,
            outboxScope,
            wireMode: 'pending_input_v1',
            requestedAction: { v: 1, kind: 'enqueue' },
            resumeWhenAvailable: true,
        })).resolves.toMatchObject({ accepted: true });
    });

    it('maps an explicit resume command to the released v1 send-now action', async () => {
        const request = vi.fn(async (_path: string, init?: RequestInit) => {
            expect(JSON.parse(String(init?.body))).toEqual({
                requestedAction: { v: 1, kind: 'send_now' },
            });
            return Response.json({ didUpdate: true });
        });

        await updatePendingRequestedActionV2({
            sessionId: 'session-resume-v1-action',
            localId: 'local-resume-v1-action',
            requestedAction: { v: 1, kind: 'enqueue' },
            resumeWhenAvailable: true,
            request,
            outboxScope,
            wireMode: 'pending_input_v1',
        });
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('rejects a supplied whitespace-only localId before persistence or transport', async () => {
        const sessionId = 'session-blank-local-id';
        storage.getState().applySessions([buildSession({ sessionId })]);
        const request = vi.fn();

        expect(() => enqueuePendingMessageV2({
            sessionId,
            localId: ' \t\r\n ',
            text: 'hello',
            encryption: { getSessionEncryption: () => null },
            request,
            outboxScope,
            wireMode: 'pending_input_v1',
            requestedAction: { v: 1, kind: 'enqueue' },
        })).toThrow('Pending localId must not be blank');
        expect(request).not.toHaveBeenCalled();
        expect((await loadPendingOutboxForSession(sessionId, outboxScope))).toEqual([]);
    });

    it('retires response-loss custody only for an exact terminal committed-message proof', async () => {
        const sessionId = 'session-terminal-rejoin';
        const localId = ' exact-terminal-local ';
        storage.getState().applySessions([buildSession({
            sessionId,
            overrides: { encryptionMode: 'plain' },
        })]);
        const encryption = await createPendingQueueEncryption({ sessionId });

        await expect(enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'hello',
            encryption,
            request: async () => Response.json({
                terminal: true,
                requestedAction: { v: 1, kind: 'enqueue' },
                message: { id: 'message-1', seq: 4, localId },
            }),
            outboxScope,
            wireMode: 'pending_input_v1',
            requestedAction: { v: 1, kind: 'enqueue' },
        })).resolves.toEqual({ accepted: true, localId, terminal: true });
        expect((await loadPendingOutboxForSession(sessionId, outboxScope))).toEqual([]);
    });

    it('reports an enqueue already settled by a concurrent owner as an explicit successful no-op', async () => {
        const sessionId = 'session-already-settled';
        const localId = 'already-settled-local';
        storage.getState().applySessions([buildSession({
            sessionId,
            overrides: { encryptionMode: 'plain' },
        })]);
        const encryption = await createPendingQueueEncryption({ sessionId });

        await expect(enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'hello',
            encryption,
            request: async () => {
                (await removePendingOutboxMessage(sessionId, localId, outboxScope));
                return Response.json({
                    terminal: true,
                    requestedAction: { v: 1, kind: 'enqueue' },
                    message: { id: 'message-1', seq: 4, localId },
                });
            },
            outboxScope,
            wireMode: 'pending_input_v1',
            requestedAction: { v: 1, kind: 'enqueue' },
        })).resolves.toEqual({ accepted: true, localId, settled: true });
        expect((await loadPendingOutboxForSession(sessionId, outboxScope))).toEqual([]);
    });

    it('keeps response-loss custody when terminal committed-message proof has another localId', async () => {
        const sessionId = 'session-terminal-mismatch';
        const localId = 'terminal-local';
        storage.getState().applySessions([buildSession({
            sessionId,
            overrides: { encryptionMode: 'plain' },
        })]);
        const encryption = await createPendingQueueEncryption({ sessionId });

        await expect(enqueuePendingMessageV2({
            sessionId,
            localId,
            text: 'hello',
            encryption,
            request: async () => Response.json({
                terminal: true,
                requestedAction: { v: 1, kind: 'enqueue' },
                message: { id: 'message-1', seq: 4, localId: 'different-local' },
            }),
            outboxScope,
            wireMode: 'pending_input_v1',
            requestedAction: { v: 1, kind: 'enqueue' },
        })).resolves.toEqual({ localId, accepted: false });
        expect((await loadPendingOutboxForSession(sessionId, outboxScope))).toEqual([
            expect.objectContaining({ localId, operation: 'enqueue' }),
        ]);
    });

    it('rejects a final-only action locally instead of downgrading it on the released wire', async () => {
        const sessionId = 'session-released-action';
        storage.getState().applySessions([buildSession({
            sessionId,
            overrides: { encryptionMode: 'plain' },
        })]);
        const encryption = await createPendingQueueEncryption({ sessionId });
        const request = vi.fn();

        await expect(enqueuePendingMessageV2({
            sessionId,
            text: 'hello',
            encryption,
            request,
            outboxScope,
            wireMode: 'released_server_v0_2_1',
            requestedAction: { v: 1, kind: 'send_now' },
        })).rejects.toMatchObject({ code: 'server-upgrade-required' });
        expect(request).not.toHaveBeenCalled();
    });

    it('re-serializes a durable current envelope when its retry resolves to the released wire', async () => {
        const sessionId = 'session-released-retry';
        storage.getState().applySessions([buildSession({
            sessionId,
            overrides: { encryptionMode: 'plain' },
        })]);
        const encryption = await createPendingQueueEncryption({ sessionId });
        await enqueuePendingMessageV2({
            sessionId,
            localId: 'local-released-retry',
            text: 'hello',
            encryption,
            request: vi.fn(),
            outboxScope,
            wireMode: 'indeterminate',
            requestedAction: { v: 1, kind: 'enqueue' },
        });
        const request = vi.fn(async (_path: string, init?: RequestInit) => {
            expect(JSON.parse(String(init?.body))).toEqual({
                localId: 'local-released-retry',
                content: expect.any(Object),
            });
            return releasedAck('local-released-retry');
        });

        await expect(retryPendingOutboxOperationV2({
            sessionId,
            localId: 'local-released-retry',
            request,
            outboxScope,
            wireMode: 'released_server_v0_2_1',
        })).resolves.toEqual({ accepted: true });
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('rejects requested-action mutation locally on the released wire', async () => {
        const request = vi.fn();

        await expect(updatePendingRequestedActionV2({
            sessionId: 'session-released-action-update',
            localId: 'local-released-action-update',
            requestedAction: { v: 1, kind: 'send_now' },
            request,
            outboxScope,
            wireMode: 'released_server_v0_2_1',
        })).rejects.toMatchObject({ code: 'server-upgrade-required' });
        expect(request).not.toHaveBeenCalled();
    });

    it('retains custody and refreshes features once after a released response-shape mismatch', async () => {
        const sessionId = 'session-released-mismatch';
        storage.getState().applySessions([buildSession({
            sessionId,
            overrides: { encryptionMode: 'plain' },
        })]);
        const encryption = await createPendingQueueEncryption({ sessionId });
        const request = vi.fn(async () => Response.json({
            requestedAction: { v: 1, kind: 'enqueue' },
        }));
        const onWireContractMismatch = vi.fn(async () => {});

        await expect(enqueuePendingMessageV2({
            sessionId,
            localId: 'local-released-mismatch',
            text: 'hello',
            encryption,
            request,
            outboxScope,
            wireMode: 'released_server_v0_2_1',
            requestedAction: { v: 1, kind: 'enqueue' },
            onWireContractMismatch,
        })).resolves.toEqual({ localId: 'local-released-mismatch', accepted: false });
        expect(request).toHaveBeenCalledTimes(1);
        expect(onWireContractMismatch).toHaveBeenCalledTimes(1);
        expect((await loadPendingOutboxForSession(sessionId, outboxScope))).toEqual([
            expect.objectContaining({ localId: 'local-released-mismatch', operation: 'enqueue' }),
        ]);
    });
});
