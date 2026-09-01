import type {
  KeyedBackoffTracker,
  KeyedLatestWorkCounters,
  KeyedLatestWorkEnqueueResult,
  KeyedLatestWorkScheduler,
  KeyedLatestWorkStats,
} from '../../../api/connection/scheduling';
import { createKeyedLatestWorkScheduler } from '../../../api/connection/scheduling';

export type ConnectedServiceQuotaPersistencePayload = Readonly<{
  materialFingerprint: string;
}>;

export type ConnectedServiceQuotaPersistenceFlushResult = Readonly<{
  timedOut: boolean;
  drained: boolean;
}>;

export type ConnectedServiceQuotaPersistenceErrorDiagnostic = Readonly<{
  name: string;
  message: string;
  status?: number;
  code?: string;
}>;

export type ConnectedServiceQuotaPersistenceCircuit<TKey extends string> = Readonly<{
  key: TKey;
  state: 'open';
  reason: 'retryable_failures' | 'nonretryable_failure';
  consecutiveFailures: number;
  openedAtMs: number;
  lastFailureAtMs: number;
  nextProbeAtMs: number | null;
  lastError: ConnectedServiceQuotaPersistenceErrorDiagnostic;
}>;

export type ConnectedServiceQuotaPersistenceScheduler<TKey extends string, TPayload extends ConnectedServiceQuotaPersistencePayload> =
  Omit<KeyedLatestWorkScheduler<TKey, TPayload>, 'flushAll'> & Readonly<{
    flushAll: (timeoutMs: number) => Promise<ConnectedServiceQuotaPersistenceFlushResult>;
    getCircuitSnapshot: () => ReadonlyArray<ConnectedServiceQuotaPersistenceCircuit<TKey>>;
  }>;

type PausedQuotaPersistencePayload<TPayload extends ConnectedServiceQuotaPersistencePayload> = {
  consecutiveFailures: number;
  openedAtMs: number;
  lastFailureAtMs: number;
  lastTouchedAtMs: number;
  lastError: ConnectedServiceQuotaPersistenceErrorDiagnostic;
  materialFingerprint: string;
  nextProbeAtMs: number | null;
  payload: TPayload;
  reason: 'retryable_failures' | 'nonretryable_failure';
};

type QuotaPersistenceFailure = Readonly<{
  consecutiveFailures: number;
  lastError: ConnectedServiceQuotaPersistenceErrorDiagnostic;
}>;

class QuotaPersistenceRetryControlError extends Error {
  public constructor(
    public readonly retry: boolean,
    public readonly originalError: unknown,
  ) {
    super('quota_persistence_retry_control');
    this.name = 'QuotaPersistenceRetryControlError';
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value));
}

function readOptionalStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as Readonly<Record<string, unknown>>;
  const direct = record.status ?? record.statusCode;
  if (typeof direct === 'number' && Number.isFinite(direct)) return Math.trunc(direct);
  const response = record.response;
  if (response && typeof response === 'object') {
    const nested = (response as Readonly<Record<string, unknown>>).status;
    if (typeof nested === 'number' && Number.isFinite(nested)) return Math.trunc(nested);
  }
  return undefined;
}

function serializePersistenceError(error: unknown): ConnectedServiceQuotaPersistenceErrorDiagnostic {
  const name = error instanceof Error && error.name.trim() ? error.name.trim() : 'Error';
  const message = error instanceof Error ? error.message : String(error ?? 'unknown_error');
  const status = readOptionalStatus(error);
  const rawCode = error && typeof error === 'object'
    ? (error as Readonly<Record<string, unknown>>).code
    : undefined;
  const code = typeof rawCode === 'string' && rawCode.trim() ? rawCode.trim() : undefined;
  return {
    name,
    message,
    ...(status !== undefined ? { status } : {}),
    ...(code ? { code } : {}),
  };
}

export function createConnectedServiceQuotaPersistenceScheduler<
  TKey extends string,
  TPayload extends ConnectedServiceQuotaPersistencePayload,
>(options: Readonly<{
  run: (key: TKey, payload: TPayload) => Promise<void>;
  maxConcurrent: number;
  minKeyIntervalMs: number;
  maxKeys: number;
  maxKeyAgeMs: number;
  maxPendingPayloadAgeMs: number;
  maxConsecutiveFailures?: number;
  now?: () => number;
  isConnected?: () => boolean;
  backoff?: KeyedBackoffTracker;
  shouldRetry?: (error: unknown) => boolean;
  shouldPauseAfterFailure?: (error: unknown) => boolean;
  onEvent?: (event: Readonly<{ type: keyof KeyedLatestWorkCounters; key: TKey; reason?: string }>) => void;
}>): ConnectedServiceQuotaPersistenceScheduler<TKey, TPayload> {
  const maxConsecutiveFailures = normalizePositiveInteger(options.maxConsecutiveFailures, 5);
  const maxPausedKeys = normalizePositiveInteger(options.maxKeys, 1);
  const now = options.now ?? Date.now;
  const pausedByKey = new Map<TKey, PausedQuotaPersistencePayload<TPayload>>();
  const failureByKey = new Map<TKey, QuotaPersistenceFailure>();
  const forceFlushKeys = new Set<TKey>();
  const probeTimersByKey = new Map<TKey, ReturnType<typeof setTimeout>>();
  let pausedSuppressedCount = 0;
  let pausedCoalescedCount = 0;

  function shouldRetry(error: unknown): boolean {
    if (error instanceof QuotaPersistenceRetryControlError) return error.retry;
    return options.shouldRetry?.(error) ?? true;
  }

  function emitSuppressed(key: TKey, reason: string): void {
    pausedSuppressedCount += 1;
    options.onEvent?.({ type: 'suppressed', key, reason });
  }

  function emitCoalesced(key: TKey, reason: string): void {
    pausedCoalescedCount += 1;
    options.onEvent?.({ type: 'coalesced', key, reason });
  }

  function clearProbeTimer(key: TKey): void {
    const timer = probeTimersByKey.get(key);
    if (!timer) return;
    clearTimeout(timer);
    probeTimersByKey.delete(key);
  }

  function evictOldestPausedKeys(protectedKey: TKey): void {
    while (pausedByKey.size > maxPausedKeys) {
      let oldestKey: TKey | null = null;
      let oldestTouchedAtMs = Number.POSITIVE_INFINITY;
      for (const [key, paused] of pausedByKey) {
        if (key === protectedKey) continue;
        if (paused.lastTouchedAtMs < oldestTouchedAtMs) {
          oldestTouchedAtMs = paused.lastTouchedAtMs;
          oldestKey = key;
        }
      }
      if (!oldestKey) return;
      clearProbeTimer(oldestKey);
      pausedByKey.delete(oldestKey);
      failureByKey.delete(oldestKey);
      forceFlushKeys.delete(oldestKey);
    }
  }

  function rememberPausedPayload(
    key: TKey,
    payload: TPayload,
    consecutiveFailures: number,
    reason: PausedQuotaPersistencePayload<TPayload>['reason'],
    error: unknown,
    nextProbeAtMs: number | null,
  ): void {
    const nowMs = now();
    const previous = pausedByKey.get(key);
    pausedByKey.set(key, {
      consecutiveFailures,
      openedAtMs: previous?.openedAtMs ?? nowMs,
      lastFailureAtMs: nowMs,
      lastTouchedAtMs: nowMs,
      lastError: serializePersistenceError(error),
      materialFingerprint: payload.materialFingerprint,
      nextProbeAtMs,
      payload,
      reason,
    });
    evictOldestPausedKeys(key);
  }

  function scheduleProbe(key: TKey): void {
    clearProbeTimer(key);
    const paused = pausedByKey.get(key);
    if (!paused || paused.reason !== 'retryable_failures' || paused.nextProbeAtMs === null) return;
    const delayMs = Math.max(1, paused.nextProbeAtMs - now());
    const timer = setTimeout(() => {
      probeTimersByKey.delete(key);
      const current = pausedByKey.get(key);
      if (!current || current.reason !== 'retryable_failures') return;
      forceFlushKeys.add(key);
      scheduler.enqueue(key, current.payload);
    }, delayMs);
    timer.unref?.();
    probeTimersByKey.set(key, timer);
  }

  function openRetryableCircuit(key: TKey, payload: TPayload, consecutiveFailures: number, error: unknown): void {
    const backoffState = options.backoff?.recordFailure(key);
    const nextProbeAtMs = backoffState?.retryAtMs ?? now() + 60_000;
    rememberPausedPayload(key, payload, consecutiveFailures, 'retryable_failures', error, nextProbeAtMs);
    scheduleProbe(key);
  }

  const scheduler = createKeyedLatestWorkScheduler<TKey, TPayload>({
    ...options,
    run: async (key, payload) => {
      const forced = forceFlushKeys.delete(key);
      try {
        await options.run(key, payload);
        clearProbeTimer(key);
        pausedByKey.delete(key);
        failureByKey.delete(key);
      } catch (error) {
        if (options.shouldPauseAfterFailure?.(error) === false) {
          clearProbeTimer(key);
          pausedByKey.delete(key);
          failureByKey.delete(key);
          throw error;
        }

        if (!shouldRetry(error)) {
          const consecutiveFailures = (failureByKey.get(key)?.consecutiveFailures ?? 0) + 1;
          failureByKey.set(key, { consecutiveFailures, lastError: serializePersistenceError(error) });
          rememberPausedPayload(key, payload, consecutiveFailures, 'nonretryable_failure', error, null);
          throw new QuotaPersistenceRetryControlError(false, error);
        }

        const previousFailure = failureByKey.get(key);
        const consecutiveFailures = forced
          ? Math.max(maxConsecutiveFailures, (previousFailure?.consecutiveFailures ?? maxConsecutiveFailures) + 1)
          : (previousFailure?.consecutiveFailures ?? 0) + 1;
        failureByKey.set(key, { consecutiveFailures, lastError: serializePersistenceError(error) });

        if (consecutiveFailures >= maxConsecutiveFailures) {
          openRetryableCircuit(key, payload, consecutiveFailures, error);
          throw new QuotaPersistenceRetryControlError(false, error);
        }

        throw error;
      }
    },
    shouldRetry,
  });

  function enqueuePausedPayloadForFlush(key: TKey, paused: PausedQuotaPersistencePayload<TPayload>): void {
    if (paused.reason === 'nonretryable_failure') return;
    clearProbeTimer(key);
    forceFlushKeys.add(key);
    scheduler.enqueue(key, paused.payload);
  }

  return {
    enqueue: (key, payload, opts): KeyedLatestWorkEnqueueResult => {
      const paused = pausedByKey.get(key);
      if (paused && paused.materialFingerprint === payload.materialFingerprint) {
        paused.payload = payload;
        paused.lastTouchedAtMs = now();
        if (paused.reason === 'retryable_failures') {
          emitCoalesced(key, 'circuit_open_retained');
          return { type: 'coalesced' };
        }
        const reason = 'paused_after_nonretryable_failure';
        emitSuppressed(key, reason);
        return { type: 'suppressed', reason };
      }
      if (paused && paused.materialFingerprint !== payload.materialFingerprint) {
        clearProbeTimer(key);
        pausedByKey.delete(key);
        failureByKey.delete(key);
        forceFlushKeys.delete(key);
        options.backoff?.reset(key);
      }
      return scheduler.enqueue(key, payload, opts);
    },
    flushKey: async (key, timeoutMs) => {
      const paused = pausedByKey.get(key);
      if (paused) enqueuePausedPayloadForFlush(key, paused);
      return await scheduler.flushKey(key, timeoutMs);
    },
    flushAll: async (timeoutMs) => {
      for (const [key, paused] of pausedByKey) {
        enqueuePausedPayloadForFlush(key, paused);
      }
      await scheduler.flushAll(timeoutMs);
      const stats = scheduler.getStats();
      const hasFlushablePausedWork = Array.from(pausedByKey.values()).some(
        (paused) => paused.reason !== 'nonretryable_failure',
      );
      const drained = stats.pendingKeyCount === 0 && stats.activeCount === 0 && !hasFlushablePausedWork;
      return {
        timedOut: !drained,
        drained,
      };
    },
    cancelKey: (key) => {
      clearProbeTimer(key);
      pausedByKey.delete(key);
      failureByKey.delete(key);
      forceFlushKeys.delete(key);
      scheduler.cancelKey(key);
    },
    dispose: () => {
      for (const key of probeTimersByKey.keys()) clearProbeTimer(key);
      pausedByKey.clear();
      failureByKey.clear();
      forceFlushKeys.clear();
      scheduler.dispose();
    },
    notifyConnectivityChanged: () => scheduler.notifyConnectivityChanged(),
    getCounters: (): KeyedLatestWorkCounters => {
      const counters = scheduler.getCounters();
      return {
        ...counters,
        coalesced: counters.coalesced + pausedCoalescedCount,
        suppressed: counters.suppressed + pausedSuppressedCount,
      };
    },
    getStats: (): KeyedLatestWorkStats => {
      const stats = scheduler.getStats();
      return { ...stats, retainedKeyCount: stats.retainedKeyCount + pausedByKey.size };
    },
    getCircuitSnapshot: () => Array.from(pausedByKey.entries()).map(([key, paused]) => ({
      key,
      state: 'open' as const,
      reason: paused.reason,
      consecutiveFailures: paused.consecutiveFailures,
      openedAtMs: paused.openedAtMs,
      lastFailureAtMs: paused.lastFailureAtMs,
      nextProbeAtMs: paused.nextProbeAtMs,
      lastError: paused.lastError,
    })),
  };
}
