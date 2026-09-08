import { afterEach, describe, expect, it, vi } from 'vitest';
import { storage } from '@/sync/domains/state/storage';
import { createMachineFixture, createSessionFixture } from '@/dev/testkit';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { sessionUsageLimitCheckNow, sessionUsageLimitWaitResumeCancel } from './sessionUsageLimitRecovery';

const transport = vi.hoisted(() => ({ machine: vi.fn(), session: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: transport.machine }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({ sessionRpcWithServerScope: transport.session }));

describe('temporary throttle machine controls', () => {
    const initial = storage.getState();
    afterEach(() => { storage.setState(initial, true); vi.clearAllMocks(); });
    it('reaches the daemon owner for retry and stop even while the session RPC is live', async () => {
        const machine = createMachineFixture({ activeAt: Date.now() });
        const session = createSessionFixture({ active: true, activeAt: Date.now() });
        storage.setState({ sessions: { [session.id]: session }, machines: { [machine.id]: machine } });
        transport.session.mockResolvedValue({ ok: true, status: 'ready' });
        transport.machine.mockResolvedValue({ ok: true, status: 'waiting' });
        expect(await sessionUsageLimitCheckNow(session.id, { serverId: 'server-a', machineOnly: true })).toMatchObject({ ok: true, status: 'waiting' });
        expect(transport.machine.mock.calls[0]?.[0]).toMatchObject({ method: RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW, machineId: machine.id });
        transport.machine.mockResolvedValue({ ok: true, status: 'cancelled' });
        expect(await sessionUsageLimitWaitResumeCancel(session.id, {
            issueFingerprint: 'temporary-throttle:one', armedAtMs: 1,
        }, { serverId: 'server-a', machineOnly: true })).toMatchObject({ ok: true, status: 'cancelled' });
        expect(transport.machine.mock.calls[1]?.[0]).toMatchObject({ method: RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL });
        expect(transport.session).not.toHaveBeenCalled();
    });
});
