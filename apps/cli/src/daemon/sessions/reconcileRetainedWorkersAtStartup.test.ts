import { describe, expect, it, vi } from 'vitest';

import type { TrackedSession } from '../types';
import { reconcileRetainedWorkersAtStartup } from './reconcileRetainedWorkersAtStartup';

function tracked(pid: number, sessionId: string): TrackedSession {
  return {
    pid,
    happySessionId: sessionId,
    startedBy: 'daemon',
    processCommandHash: `hash-${pid}`,
    processInstanceFingerprint: `instance-${pid}`,
    reattachedFromDiskMarker: true,
  };
}

describe('reconcileRetainedWorkersAtStartup', () => {
  it('keeps authenticated active and unverified workers, stopping only authoritatively stale sessions', async () => {
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [101, tracked(101, 'active')],
      [102, tracked(102, 'inactive')],
      [103, tracked(103, 'missing')],
      [104, tracked(104, 'unreachable')],
    ]);
    const fetchSession = vi.fn(async (sessionId: string) => {
      if (sessionId === 'active') return { id: sessionId, active: true };
      if (sessionId === 'inactive') return { id: sessionId, active: false };
      if (sessionId === 'missing') return null;
      throw new Error('relay unavailable');
    });
    const stopSession = vi.fn(async (sessionId: string) => {
      for (const [pid, trackedSession] of pidToTrackedSession) {
        if (trackedSession.happySessionId === sessionId) pidToTrackedSession.delete(pid);
      }
      return { status: 'stopped' as const };
    });
    const wakeSession = vi.fn(async () => ({ type: 'wake_published' as const }));

    const result = await reconcileRetainedWorkersAtStartup({
      pidToTrackedSession,
      fetchSession,
      stopSession,
      wakeSession,
      maxConcurrentQueries: 2,
    });

    expect(stopSession.mock.calls.map(([sessionId]) => sessionId).sort()).toEqual(['inactive', 'missing']);
    expect(wakeSession).toHaveBeenCalledTimes(1);
    expect(wakeSession).toHaveBeenCalledWith('active');
    expect([...pidToTrackedSession.keys()].sort()).toEqual([101, 104]);
    expect(result).toEqual({
      authenticatedActivePids: [101],
      activeWakeDiagnostics: [{ sessionId: 'active', diagnostic: { type: 'wake_published' } }],
      staleStopRequestedPids: [102, 103],
      staleStopFailedPids: [],
      unresolved: [{ sessionId: 'unreachable', pids: [104], reason: 'relay unavailable' }],
      peakQueuedQueries: 2,
    });
  });

  it('does not use marker age and preserves a stale candidate when graceful stop cannot prove success', async () => {
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [201, tracked(201, 'inactive-old-marker')],
    ]);

    const result = await reconcileRetainedWorkersAtStartup({
      pidToTrackedSession,
      fetchSession: async () => ({ id: 'inactive-old-marker', active: false }),
      stopSession: async () => ({ status: 'incomplete', reason: 'runner_exit_timeout' }),
      wakeSession: async () => ({ type: 'wake_published' }),
      maxConcurrentQueries: 1,
    });

    expect(pidToTrackedSession.has(201)).toBe(true);
    expect(result.staleStopRequestedPids).toEqual([]);
    expect(result.staleStopFailedPids).toEqual([201]);
  });

  it('keeps startup alive and reports a confirmed-stale worker when graceful stop throws', async () => {
    const pidToTrackedSession = new Map<number, TrackedSession>([
      [301, tracked(301, 'inactive-stop-error')],
    ]);

    const result = await reconcileRetainedWorkersAtStartup({
      pidToTrackedSession,
      fetchSession: async () => ({ id: 'inactive-stop-error', active: false }),
      stopSession: async () => { throw new Error('stop transport failed'); },
      wakeSession: async () => ({ type: 'wake_published' }),
      maxConcurrentQueries: 1,
    });

    expect(pidToTrackedSession.has(301)).toBe(true);
    expect(result.staleStopFailedPids).toEqual([301]);
  });
});
