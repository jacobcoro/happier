import { describe, expect, it, vi } from 'vitest';
import { ScmDiffCache } from './scmDiffCache';
import { resolveSessionScmDiffCacheScope } from './scmDiffCacheKey';

const environment = vi.hoisted(() => ({ serverId: 'server-a' }));
vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: environment.serverId }),
}));
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({ storage: { getState: () => ({ sessions: {}, sessionListRenderables: {} }) } });
});

describe('session diff authority', () => {
    it('isolates the same session id when the active server changes', () => {
        const cache = new ScmDiffCache({ maxEntries: 10, maxTotalBytes: 10_000, now: () => 1 });
        const key = () => ({ sessionId: resolveSessionScmDiffCacheScope('s1'), snapshotSignature: 'fresh', diffArea: 'pending' as const, path: 'a.ts' });
        environment.serverId = 'server-a';
        cache.set(key(), 'patch-a');
        environment.serverId = 'server-b';
        expect(cache.get(key())).toBeNull();
        cache.set(key(), 'patch-b');
        environment.serverId = 'server-a';
        expect(cache.get(key())?.diff).toBe('patch-a');
    });
});
