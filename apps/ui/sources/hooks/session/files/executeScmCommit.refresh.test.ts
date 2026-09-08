import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installSessionFilesHookCommonModuleMocks } from './sessionFilesHookTestHelpers';
const { rpc, alert } = vi.hoisted(() => ({ rpc: vi.fn(), alert: vi.fn() }));
installSessionFilesHookCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { alert } }).module;
    },
    storage: async (original) => original(),
});
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({ sessionRpcWithServerScope: rpc }));
// Load the real SCM operations without the unrelated sync operations barrel.
vi.mock('@/sync/ops', async () => import('@/sync/ops/sessionScm'));
vi.mock('@/sync/sync', () => ({ sync: { encryption: { getSessionEncryption: () => null } } }));
const { storage } = await import('@/sync/domains/state/storage');
const { projectManager } = await import('@/sync/runtime/orchestration/projectManager');
const { executeScmCommit } = await import('./executeScmCommit');
describe('commit result survives refresh failure', () => {
    beforeEach(() => {
        storage.setState(storage.getInitialState(), true);
        projectManager.clear();
        storage.getState().applySessions([createSessionFixture({ id: 's1', active: true, metadata: { path: '/tmp/commit-test', host: 'localhost' } })]);
        storage.getState().markSessionProjectScmCommitSelectionPaths('s1', ['a.txt']);
        storage.getState().upsertSessionProjectScmCommitSelectionPatch('s1', { path: 'b.txt', patch: 'patch' });
        rpc.mockReset().mockResolvedValue({ success: true, commitSha: 'abc123' });
        alert.mockReset();
    });
    it.each(['status', 'history', 'feedback', 'reporting'] as const)('preserves success and only retries refresh after %s fails', async (failure) => {
        const refreshScmData = vi.fn(async () => {});
        const loadCommitHistory = vi.fn(async () => {});
        const setScmOperationStatus = vi.fn<(status: string | null) => void>();
        const capture = vi.fn();
        const refreshAttempts = failure === 'status' || failure === 'history' ? 1 : 0;
        if (failure === 'reporting') capture.mockImplementationOnce(() => { throw new Error('telemetry unavailable'); });
        else if (failure === 'feedback') setScmOperationStatus.mockImplementationOnce(() => { throw new Error('feedback unavailable'); });
        else (failure === 'status' ? refreshScmData : loadCommitHistory).mockRejectedValueOnce(new Error('RPC method not available'));
        const result = await executeScmCommit({
            sessionId: 's1', commitMessage: 'commit', scmCommitStrategy: 'atomic',
            commitSelectionPaths: ['a.txt'], commitSelectionPatches: [{ path: 'b.txt', patch: 'patch' }],
            refreshScmData, loadCommitHistory, setScmOperationBusy: vi.fn(), setScmOperationStatus, tracking: { capture },
        });
        expect(refreshScmData).toHaveBeenCalledTimes(refreshAttempts);
        expect(result.ok).toBe(true);
        expect(storage.getState().getSessionProjectScmCommitSelectionPaths('s1')).toEqual([]);
        expect(storage.getState().getSessionProjectScmCommitSelectionPatches('s1')).toEqual([]);
        const log = storage.getState().getSessionProjectScmOperationLog('s1');
        expect(log).toEqual(expect.arrayContaining([
            expect.objectContaining({ operation: 'commit', status: 'success', detail: 'abc123' }),
            expect.objectContaining({ operation: 'refresh', status: 'failed' }),
        ]));
        expect(log).not.toEqual(expect.arrayContaining([expect.objectContaining({ operation: 'commit', status: 'failed' })]));
        const buttons = alert.mock.calls[0]?.[2] as Array<{ text: string; onPress?: () => Promise<void> }>;
        await buttons.find((button) => button.text === 'files.retryRefresh')?.onPress?.();
        expect(refreshScmData).toHaveBeenCalledTimes(refreshAttempts + 1);
        expect(rpc).toHaveBeenCalledTimes(1);
        expect(storage.getState().getSessionProjectScmOperationLog('s1')).toEqual(expect.arrayContaining([expect.objectContaining({ operation: 'refresh', status: 'success' })]));
        expect(storage.getState().getSessionProjectScmInFlightOperation('s1')).toBeNull();
    });
});
