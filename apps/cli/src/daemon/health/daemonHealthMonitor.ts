import type { ConnectedServiceQuotaPersistenceCircuit } from '../connectedServices/quotas/createConnectedServiceQuotaPersistenceScheduler';
import type { RetainedWorkerReconciliationResult } from '../sessions/reconcileRetainedWorkersAtStartup';

const GIB = 1024 ** 3;

export type DaemonResourceSample = Readonly<{
  controllerRssBytes: number | null;
  workerRssBytes: number | null;
  swapUsedBytes: number | null;
  swapTotalBytes: number | null;
  swapSource: string;
}>;

export type DaemonHealthAlert = Readonly<{
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
}>;

export type DaemonHealthSnapshot = Readonly<{
  status: 'healthy' | 'warning' | 'error';
  observedAtMs: number;
  workers: Readonly<{
    count: number;
    warningLimit: number;
    hardLimit: number;
  }>;
  resources: DaemonResourceSample & Readonly<{
    rssWarningBytes: number;
    rssHardBytes: number;
    swapWarningRatio: number;
    swapHardRatio: number;
  }>;
  sessionListQueries: Readonly<{
    active: number;
    queued: number;
    peakQueued: number;
    rejected: number;
    maxConcurrent: number;
    maxQueued: number;
  }>;
  quotaPersistenceCircuits: ReadonlyArray<ConnectedServiceQuotaPersistenceCircuit<string>>;
  startupReconciliation: RetainedWorkerReconciliationResult | null;
  alerts: readonly DaemonHealthAlert[];
}>;

export type DaemonHealthMonitor = Readonly<{
  runSessionListQuery<T>(operation: () => Promise<T> | T): Promise<T>;
  checkWorkerAdmission(): Promise<
    | Readonly<{ allowed: true }>
    | Readonly<{ allowed: false; code: string; message: string }>
  >;
  getSnapshot(): Promise<DaemonHealthSnapshot>;
}>;

type QueuedOperation = Readonly<{
  start: () => void;
  reject: (error: Error) => void;
}>;

function safeNonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export function createDaemonHealthMonitor(params: Readonly<{
  getWorkerPids: () => readonly number[];
  sampleResources: (workerPids: readonly number[]) => Promise<DaemonResourceSample>;
  getQuotaPersistenceCircuits: () => ReadonlyArray<ConnectedServiceQuotaPersistenceCircuit<string>>;
  getStartupReconciliation: () => RetainedWorkerReconciliationResult | null;
  now?: () => number;
  limits?: Partial<Readonly<{
    workerWarning: number;
    workerHard: number;
    rssWarningBytes: number;
    rssHardBytes: number;
    swapWarningRatio: number;
    swapHardRatio: number;
    listMaxConcurrent: number;
    listMaxQueued: number;
  }>>;
}>): DaemonHealthMonitor {
  const limits = {
    workerWarning: params.limits?.workerWarning ?? 40,
    workerHard: params.limits?.workerHard ?? 64,
    rssWarningBytes: params.limits?.rssWarningBytes ?? 12 * GIB,
    rssHardBytes: params.limits?.rssHardBytes ?? 16 * GIB,
    swapWarningRatio: params.limits?.swapWarningRatio ?? 0.25,
    swapHardRatio: params.limits?.swapHardRatio ?? 0.75,
    listMaxConcurrent: Math.max(1, safeNonNegativeInteger(params.limits?.listMaxConcurrent ?? 2)),
    listMaxQueued: Math.max(1, safeNonNegativeInteger(params.limits?.listMaxQueued ?? 256)),
  };
  const now = params.now ?? Date.now;
  const queue: QueuedOperation[] = [];
  let active = 0;
  let peakQueued = 0;
  let rejected = 0;

  const startNext = (): void => {
    while (active < limits.listMaxConcurrent && queue.length > 0) {
      const next = queue.shift();
      next?.start();
    }
  };

  const runSessionListQuery = async <T>(operation: () => Promise<T> | T): Promise<T> => {
    return await new Promise<T>((resolve, reject) => {
      const start = () => {
        active += 1;
        void Promise.resolve()
          .then(operation)
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            startNext();
          });
      };
      if (active < limits.listMaxConcurrent) {
        start();
        return;
      }
      if (queue.length >= limits.listMaxQueued) {
        rejected += 1;
        reject(new Error('daemon_session_list_queue_limit_reached'));
        return;
      }
      queue.push({ start, reject });
      peakQueued = Math.max(peakQueued, queue.length);
    });
  };

  const getSnapshot = async (): Promise<DaemonHealthSnapshot> => {
    const workerPids = params.getWorkerPids();
    const resources = await params.sampleResources(workerPids);
    const circuits = params.getQuotaPersistenceCircuits();
    const reconciliation = params.getStartupReconciliation();
    const alerts: DaemonHealthAlert[] = [];

    if (workerPids.length >= limits.workerHard) {
      alerts.push({ code: 'worker_count_error', severity: 'error', message: `Worker hard limit reached (${workerPids.length}/${limits.workerHard})` });
    } else if (workerPids.length >= limits.workerWarning) {
      alerts.push({ code: 'worker_count_warning', severity: 'warning', message: `Worker count is high (${workerPids.length}/${limits.workerWarning})` });
    }

    const totalRssBytes = resources.controllerRssBytes === null || resources.workerRssBytes === null
      ? null
      : resources.controllerRssBytes + resources.workerRssBytes;
    if (totalRssBytes !== null && totalRssBytes >= limits.rssHardBytes) {
      alerts.push({ code: 'worker_rss_error', severity: 'error', message: `Daemon and worker RSS reached the hard limit (${totalRssBytes}/${limits.rssHardBytes} bytes)` });
    } else if (totalRssBytes !== null && totalRssBytes >= limits.rssWarningBytes) {
      alerts.push({ code: 'worker_rss_warning', severity: 'warning', message: `Daemon and worker RSS is high (${totalRssBytes}/${limits.rssWarningBytes} bytes)` });
    }

    const swapRatio = resources.swapUsedBytes !== null
      && resources.swapTotalBytes !== null
      && resources.swapTotalBytes > 0
      ? resources.swapUsedBytes / resources.swapTotalBytes
      : null;
    if (swapRatio !== null && swapRatio >= limits.swapHardRatio) {
      alerts.push({ code: 'swap_usage_error', severity: 'error', message: `Swap use is critical (${Math.round(swapRatio * 100)}%)` });
    } else if (swapRatio !== null && swapRatio >= limits.swapWarningRatio) {
      alerts.push({ code: 'swap_usage_warning', severity: 'warning', message: `Swap use is high (${Math.round(swapRatio * 100)}%)` });
    } else if (swapRatio === null) {
      alerts.push({ code: 'swap_usage_unavailable', severity: 'info', message: `Swap usage is unavailable (${resources.swapSource})` });
    }

    if (queue.length > 0 || peakQueued > 0) {
      alerts.push({ code: 'session_list_queries_queued', severity: 'warning', message: `Session-list queries queued (current ${queue.length}, peak ${peakQueued})` });
    }
    if (rejected > 0) {
      alerts.push({ code: 'session_list_query_queue_error', severity: 'error', message: `Session-list queue rejected ${rejected} requests` });
    }
    if (circuits.length > 0) {
      alerts.push({ code: 'quota_persistence_circuit_open', severity: 'warning', message: `${circuits.length} quota-persistence circuit(s) open` });
    }
    if ((reconciliation?.staleStopFailedPids.length ?? 0) > 0) {
      alerts.push({ code: 'startup_worker_stop_failed', severity: 'error', message: `${reconciliation?.staleStopFailedPids.length ?? 0} confirmed-stale worker(s) did not stop` });
    }
    if ((reconciliation?.unresolved.length ?? 0) > 0) {
      alerts.push({ code: 'startup_worker_unresolved', severity: 'warning', message: `${reconciliation?.unresolved.length ?? 0} retained worker session(s) could not be authenticated` });
    }
    const unavailableWakes = reconciliation?.activeWakeDiagnostics.filter(({ diagnostic }) => diagnostic.type === 'unavailable') ?? [];
    if (unavailableWakes.length > 0) {
      alerts.push({ code: 'startup_pending_wake_unavailable', severity: 'warning', message: `${unavailableWakes.length} authenticated active runner wake(s) were unavailable` });
    }

    return {
      status: alerts.some((alert) => alert.severity === 'error')
        ? 'error'
        : alerts.some((alert) => alert.severity === 'warning')
          ? 'warning'
          : 'healthy',
      observedAtMs: now(),
      workers: {
        count: workerPids.length,
        warningLimit: limits.workerWarning,
        hardLimit: limits.workerHard,
      },
      resources: {
        ...resources,
        rssWarningBytes: limits.rssWarningBytes,
        rssHardBytes: limits.rssHardBytes,
        swapWarningRatio: limits.swapWarningRatio,
        swapHardRatio: limits.swapHardRatio,
      },
      sessionListQueries: {
        active,
        queued: queue.length,
        peakQueued,
        rejected,
        maxConcurrent: limits.listMaxConcurrent,
        maxQueued: limits.listMaxQueued,
      },
      quotaPersistenceCircuits: circuits,
      startupReconciliation: reconciliation,
      alerts,
    };
  };

  return {
    runSessionListQuery,
    checkWorkerAdmission: async () => {
      const workerCount = params.getWorkerPids().length;
      if (workerCount >= limits.workerHard) {
        return {
          allowed: false as const,
          code: 'daemon_worker_limit_reached',
          message: `Daemon worker hard limit reached (${workerCount}/${limits.workerHard})`,
        };
      }
      const snapshot = await getSnapshot();
      const rss = snapshot.resources.controllerRssBytes === null || snapshot.resources.workerRssBytes === null
        ? null
        : snapshot.resources.controllerRssBytes + snapshot.resources.workerRssBytes;
      if (rss !== null && rss >= limits.rssHardBytes) {
        return { allowed: false as const, code: 'daemon_rss_limit_reached', message: `Daemon RSS hard limit reached (${rss}/${limits.rssHardBytes} bytes)` };
      }
      const swapRatio = snapshot.resources.swapUsedBytes !== null
        && snapshot.resources.swapTotalBytes !== null
        && snapshot.resources.swapTotalBytes > 0
        ? snapshot.resources.swapUsedBytes / snapshot.resources.swapTotalBytes
        : null;
      if (swapRatio !== null && swapRatio >= limits.swapHardRatio) {
        return { allowed: false as const, code: 'daemon_swap_limit_reached', message: `Daemon swap hard limit reached (${Math.round(swapRatio * 100)}%)` };
      }
      return { allowed: true as const };
    },
    getSnapshot,
  };
}
