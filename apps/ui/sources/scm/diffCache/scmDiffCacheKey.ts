import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { buildSnapshotSignature } from '@/scm/statusSync/projectState';

// Equal status/line counts do not establish equal file contents across refreshes.
export function buildScmDiffSnapshotSignature(snapshot: ScmWorkingSnapshot, shapeSignature = buildSnapshotSignature(snapshot)): string {
    return JSON.stringify([shapeSignature, snapshot.fetchedAt]);
}

export function resolveSessionScmDiffCacheScope(sessionId: string): string {
    const serverId = resolvePreferredServerIdForSessionId(sessionId) ?? getActiveServerSnapshot().serverId;
    return JSON.stringify(['session', serverId, sessionId]);
}
