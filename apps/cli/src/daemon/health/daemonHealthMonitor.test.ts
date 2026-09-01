import { describe, expect, it } from 'vitest';

import { createDaemonHealthMonitor } from './daemonHealthMonitor';

describe('createDaemonHealthMonitor', () => {
  it('reports worker, RSS, swap, queue, reconciliation, and quota circuit alerts locally', async () => {
    const monitor = createDaemonHealthMonitor({
      getWorkerPids: () => Array.from({ length: 48 }, (_, index) => 10_000 + index),
      sampleResources: async () => ({
        controllerRssBytes: 512 * 1024 ** 2,
        workerRssBytes: 15 * 1024 ** 3,
        swapUsedBytes: 7 * 1024 ** 3,
        swapTotalBytes: 8 * 1024 ** 3,
        swapSource: 'linux_proc_meminfo',
      }),
      getQuotaPersistenceCircuits: () => [{
        key: 'openai:profile-a',
        state: 'open',
        reason: 'retryable_failures',
        consecutiveFailures: 5,
        openedAtMs: 1_000,
        lastFailureAtMs: 2_000,
        nextProbeAtMs: 33_000,
        lastError: {
          name: 'AxiosError',
          message: 'provider_account_usage_persistence_paused_after_failures',
          status: 503,
          code: 'provider_account_usage_persistence_paused_after_failures',
        },
      }],
      getStartupReconciliation: () => ({
        authenticatedActivePids: [10_000],
        activeWakeDiagnostics: [{
          sessionId: 'active-session',
          diagnostic: { type: 'unavailable', reason: 'transport_unavailable' },
        }],
        staleStopRequestedPids: [],
        staleStopFailedPids: [10_001],
        unresolved: [{ sessionId: 'unknown-session', pids: [10_002], reason: 'relay unavailable' }],
        peakQueuedQueries: 44,
      }),
    });

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const operations = Array.from({ length: 6 }, (_, index) => monitor.runSessionListQuery(async () => {
      await blocked;
      return index;
    }));
    await Promise.resolve();
    const queuedSnapshot = await monitor.getSnapshot();
    expect(queuedSnapshot.sessionListQueries).toMatchObject({ active: 2, queued: 4, maxConcurrent: 2 });
    release();
    await Promise.all(operations);

    const snapshot = await monitor.getSnapshot();
    expect(snapshot.status).toBe('error');
    expect(snapshot.workers).toMatchObject({ count: 48, warningLimit: 40, hardLimit: 64 });
    expect(snapshot.resources).toMatchObject({ workerRssBytes: 15 * 1024 ** 3, swapUsedBytes: 7 * 1024 ** 3 });
    expect(snapshot.sessionListQueries.peakQueued).toBe(4);
    expect(snapshot.quotaPersistenceCircuits[0]?.lastError).toMatchObject({
      status: 503,
      code: 'provider_account_usage_persistence_paused_after_failures',
    });
    expect(snapshot.alerts.map((alert) => alert.code)).toEqual(expect.arrayContaining([
      'worker_count_warning',
      'worker_rss_warning',
      'swap_usage_error',
      'session_list_queries_queued',
      'quota_persistence_circuit_open',
      'startup_worker_stop_failed',
      'startup_worker_unresolved',
      'startup_pending_wake_unavailable',
    ]));
  });

  it('rejects worker admission at the hard count limit without stopping existing workers', async () => {
    const pids = Array.from({ length: 64 }, (_, index) => 20_000 + index);
    const monitor = createDaemonHealthMonitor({
      getWorkerPids: () => pids,
      sampleResources: async () => ({
        controllerRssBytes: 1,
        workerRssBytes: 1,
        swapUsedBytes: 0,
        swapTotalBytes: 1,
        swapSource: 'test',
      }),
      getQuotaPersistenceCircuits: () => [],
      getStartupReconciliation: () => null,
    });

    await expect(monitor.checkWorkerAdmission()).resolves.toEqual({
      allowed: false,
      code: 'daemon_worker_limit_reached',
      message: 'Daemon worker hard limit reached (64/64)',
    });
    expect(pids).toHaveLength(64);
  });
});
