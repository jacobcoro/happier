import { describe, expect, it, vi } from 'vitest';

import { createSyncBackedSubmitPort } from './syncBackedSubmitPort';

describe('createSyncBackedSubmitPort', () => {
    it('forwards a requested-action update through the Sync runtime', async () => {
        const updatePendingRequestedAction = vi.fn(async (): Promise<void> => {});
        const runtime = {
            abortSession: vi.fn(async () => {}),
            enqueuePendingMessage: vi.fn(async () => ({ localId: 'pending-1', accepted: true })),
            sendMessage: vi.fn(async () => ({ localId: 'direct-1', persistence: 'pending' as const })),
            updatePendingRequestedAction,
            encryption: { getMachineEncryption: vi.fn(() => null) },
            refreshSessionForSubmit: vi.fn(async () => null),
        };

        const port = createSyncBackedSubmitPort(runtime);
        const requestedAction = { v: 1, kind: 'steer_now' } as const;
        await port.updatePendingRequestedAction?.('s1', 'pending-1', requestedAction);

        expect(updatePendingRequestedAction).toHaveBeenCalledWith('s1', 'pending-1', requestedAction, undefined);
    });
});
