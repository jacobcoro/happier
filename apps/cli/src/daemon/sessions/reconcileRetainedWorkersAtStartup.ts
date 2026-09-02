import type { TrackedSession } from '../types';
import type { SessionPendingQueueWakeDiagnostic } from './pendingQueueWake';
import type { StopSessionResult } from './stopSessionContract';

type RetainedSessionRecord = Readonly<{
  id: string;
  active: boolean;
}>;

export type RetainedWorkerReconciliationResult = Readonly<{
  authenticatedActivePids: readonly number[];
  activeWakeDiagnostics: ReadonlyArray<Readonly<{
    sessionId: string;
    diagnostic: SessionPendingQueueWakeDiagnostic;
  }>>;
  staleStopRequestedPids: readonly number[];
  staleStopFailedPids: readonly number[];
  unresolved: ReadonlyArray<Readonly<{
    sessionId: string;
    pids: readonly number[];
    reason: string;
  }>>;
  peakQueuedQueries: number;
}>;

function normalizePositiveInteger(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.trunc(value));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'unknown_error');
}

/**
 * Authenticated startup reconciliation for workers retained by KillMode=process.
 * Age and idle duration are deliberately absent: only authoritative session state can retire a worker.
 */
export async function reconcileRetainedWorkersAtStartup(params: Readonly<{
  pidToTrackedSession: Map<number, TrackedSession>;
  fetchSession: (sessionId: string) => Promise<RetainedSessionRecord | null>;
  stopSession: (sessionId: string) => Promise<StopSessionResult>;
  wakeSession: (sessionId: string) => Promise<SessionPendingQueueWakeDiagnostic>;
  maxConcurrentQueries: number;
}>): Promise<RetainedWorkerReconciliationResult> {
  const pidsBySessionId = new Map<string, number[]>();
  for (const [pid, trackedSession] of params.pidToTrackedSession) {
    const sessionId = trackedSession.happySessionId?.trim() ?? '';
    if (!sessionId) continue;
    const pids = pidsBySessionId.get(sessionId) ?? [];
    pids.push(pid);
    pidsBySessionId.set(sessionId, pids);
  }

  const entries = Array.from(pidsBySessionId.entries());
  const maxConcurrent = Math.min(normalizePositiveInteger(params.maxConcurrentQueries), Math.max(1, entries.length));
  const authenticatedActivePids: number[] = [];
  const activeWakeDiagnostics: Array<{
    sessionId: string;
    diagnostic: SessionPendingQueueWakeDiagnostic;
  }> = [];
  const staleStopRequestedPids: number[] = [];
  const staleStopFailedPids: number[] = [];
  const unresolved: Array<{ sessionId: string; pids: readonly number[]; reason: string }> = [];
  let nextIndex = 0;
  const peakQueuedQueries = Math.max(0, entries.length - maxConcurrent);

  const runNext = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= entries.length) return;
      const [sessionId, pids] = entries[index]!;
      let session: RetainedSessionRecord | null;
      try {
        session = await params.fetchSession(sessionId);
      } catch (error) {
        unresolved.push({ sessionId, pids, reason: formatError(error) });
        continue;
      }

      if (session?.active === true) {
        authenticatedActivePids.push(...pids);
        try {
          activeWakeDiagnostics.push({
            sessionId,
            diagnostic: await params.wakeSession(sessionId),
          });
        } catch {
          activeWakeDiagnostics.push({
            sessionId,
            diagnostic: { type: 'unavailable', reason: 'rpc_failed' },
          });
        }
        continue;
      }

      let stopResult: StopSessionResult;
      try {
        stopResult = await params.stopSession(sessionId);
      } catch {
        staleStopFailedPids.push(...pids.filter((pid) => params.pidToTrackedSession.has(pid)));
        continue;
      }
      const allExited = pids.every((pid) => !params.pidToTrackedSession.has(pid));
      if (stopResult.status === 'stopped' && allExited) {
        staleStopRequestedPids.push(...pids);
      } else {
        staleStopFailedPids.push(...pids.filter((pid) => params.pidToTrackedSession.has(pid)));
      }
    }
  };

  await Promise.all(Array.from({ length: maxConcurrent }, () => runNext()));

  return {
    authenticatedActivePids: authenticatedActivePids.sort((a, b) => a - b),
    activeWakeDiagnostics: activeWakeDiagnostics.sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    staleStopRequestedPids: staleStopRequestedPids.sort((a, b) => a - b),
    staleStopFailedPids: staleStopFailedPids.sort((a, b) => a - b),
    unresolved: unresolved.sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    peakQueuedQueries,
  };
}
