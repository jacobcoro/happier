import { afterEach, describe, expect, it, vi } from 'vitest';

import { createKeyedBackoffTracker } from '../../../api/connection/scheduling/createKeyedBackoffTracker';
import { createConnectedServiceQuotaPersistenceScheduler } from './createConnectedServiceQuotaPersistenceScheduler';

type TestPayload = Readonly<{
  materialFingerprint: string;
  value: string;
}>;

function createDeferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe('createConnectedServiceQuotaPersistenceScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function createScheduler(input: Readonly<{
    now: () => number;
    run: (key: string, payload: TestPayload) => Promise<void>;
    maxKeys?: number;
    maxConsecutiveFailures?: number;
    shouldRetry?: (error: unknown) => boolean;
    shouldPauseAfterFailure?: (error: unknown) => boolean;
  }>) {
    return createConnectedServiceQuotaPersistenceScheduler<string, TestPayload>({
      run: input.run,
      maxConcurrent: 1,
      minKeyIntervalMs: 0,
      maxKeys: input.maxKeys ?? 10,
      maxKeyAgeMs: 60_000,
      maxPendingPayloadAgeMs: 60_000,
      maxConsecutiveFailures: input.maxConsecutiveFailures ?? 5,
      now: input.now,
      backoff: createKeyedBackoffTracker({
        baseDelayMs: 1,
        maxDelayMs: 1,
        jitterRatio: 0,
        now: input.now,
      }),
      shouldRetry: input.shouldRetry ?? (() => true),
      shouldPauseAfterFailure: input.shouldPauseAfterFailure,
    });
  }

  it('opens after five retryable failures, retaining same-fingerprint intake until material changes', async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const attempts: string[] = [];
    const scheduler = createScheduler({
      now: () => nowMs,
      run: async (_key, payload) => {
        attempts.push(payload.materialFingerprint);
        if (payload.materialFingerprint === 'fp-old') throw new Error('retryable');
      },
    });

    expect(scheduler.enqueue('profile', { materialFingerprint: 'fp-old', value: 'first' }).type).toBe('accepted');
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 1; index < 5; index += 1) {
      nowMs += 1;
      await vi.advanceTimersByTimeAsync(1);
    }

    expect(attempts).toEqual(['fp-old', 'fp-old', 'fp-old', 'fp-old', 'fp-old']);
    expect(scheduler.enqueue('profile', { materialFingerprint: 'fp-old', value: 'same-material' })).toEqual({
      type: 'coalesced',
    });
    expect(scheduler.enqueue('profile', { materialFingerprint: 'fp-new', value: 'changed-material' }).type).toBe('accepted');
    nowMs += 1;
    await vi.advanceTimersByTimeAsync(1);

    expect(attempts).toEqual(['fp-old', 'fp-old', 'fp-old', 'fp-old', 'fp-old', 'fp-new']);
  });

  it('allows an explicit flush to retry the paused latest same-fingerprint payload once', async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    let shouldFail = true;
    const attempts: string[] = [];
    const scheduler = createScheduler({
      now: () => nowMs,
      run: async (_key, payload) => {
        attempts.push(payload.value);
        if (shouldFail) throw new Error('retryable');
      },
    });

    scheduler.enqueue('profile', { materialFingerprint: 'fp', value: 'initial' });
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 1; index < 5; index += 1) {
      nowMs += 1;
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(attempts).toEqual(['initial', 'initial', 'initial', 'initial', 'initial']);

    expect(scheduler.enqueue('profile', { materialFingerprint: 'fp', value: 'latest-same-material' })).toEqual({
      type: 'coalesced',
    });
    shouldFail = false;
    const flushedPromise = scheduler.flushKey('profile', 1_000);
    await vi.runAllTimersAsync();
    const flushed = await flushedPromise;

    expect(flushed).toBe(true);
    expect(attempts).toEqual(['initial', 'initial', 'initial', 'initial', 'initial', 'latest-same-material']);
  });

  it('acknowledges retained intake while open, preserves the real error, and closes after one bounded probe', async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    let shouldFail = true;
    const attempts: string[] = [];
    const scheduler = createConnectedServiceQuotaPersistenceScheduler<string, TestPayload>({
      run: async (_key, payload) => {
        attempts.push(payload.value);
        if (shouldFail) {
          const error = new Error('503 upstream provider quota write unavailable');
          Object.assign(error, { status: 503, code: 'provider_account_usage_persistence_paused_after_failures' });
          throw error;
        }
      },
      maxConcurrent: 1,
      minKeyIntervalMs: 0,
      maxKeys: 10,
      maxKeyAgeMs: 60_000,
      maxPendingPayloadAgeMs: 60_000,
      maxConsecutiveFailures: 2,
      now: () => nowMs,
      backoff: createKeyedBackoffTracker({
        baseDelayMs: 10,
        maxDelayMs: 20,
        jitterRatio: 0,
        now: () => nowMs,
      }),
      shouldRetry: () => true,
    });

    expect(scheduler.enqueue('profile', { materialFingerprint: 'fp', value: 'initial' })).toEqual({
      type: 'accepted',
    });
    await vi.advanceTimersByTimeAsync(0);
    nowMs = 10;
    await vi.advanceTimersByTimeAsync(10);

    expect(attempts).toEqual(['initial', 'initial']);
    expect(scheduler.getCircuitSnapshot()).toEqual([
      expect.objectContaining({
        key: 'profile',
        state: 'open',
        consecutiveFailures: 2,
        nextProbeAtMs: 30,
        lastError: {
          name: 'Error',
          message: '503 upstream provider quota write unavailable',
          status: 503,
          code: 'provider_account_usage_persistence_paused_after_failures',
        },
      }),
    ]);
    expect(scheduler.enqueue('profile', { materialFingerprint: 'fp', value: 'latest-retained' })).toEqual({
      type: 'coalesced',
    });

    nowMs = 29;
    await vi.advanceTimersByTimeAsync(19);
    expect(attempts).toHaveLength(2);

    shouldFail = false;
    nowMs = 30;
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toEqual(['initial', 'initial', 'latest-retained']);
    expect(scheduler.getCircuitSnapshot()).toEqual([]);
  });

  it('suppresses same-fingerprint work after a non-retryable failure without blocking flush', async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const attempts: string[] = [];
    const scheduler = createScheduler({
      now: () => nowMs,
      shouldRetry: () => false,
      run: async (_key, payload) => {
        attempts.push(payload.value);
        throw new Error('non-retryable');
      },
    });

    expect(scheduler.enqueue('profile', { materialFingerprint: 'fp-old', value: 'first' }).type).toBe('accepted');
    await vi.runAllTimersAsync();
    expect(attempts).toEqual(['first']);

    expect(scheduler.enqueue('profile', { materialFingerprint: 'fp-old', value: 'same-material' })).toEqual({
      type: 'suppressed',
      reason: 'paused_after_nonretryable_failure',
    });
    const flushed = scheduler.flushAll(25);
    await vi.advanceTimersByTimeAsync(25);
    await expect(flushed).resolves.toEqual({ timedOut: false, drained: true });
    expect(attempts).toEqual(['first']);

    expect(scheduler.enqueue('profile', { materialFingerprint: 'fp-new', value: 'changed-material' }).type).toBe('accepted');
    await vi.runAllTimersAsync();
    expect(attempts).toEqual(['first', 'changed-material']);
  });

  it('does not pause same-fingerprint work when a non-retryable failure is explicitly non-pausing', async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    let shouldFail = true;
    const attempts: string[] = [];
    const nonPausingError = new Error('mode unavailable');
    const scheduler = createScheduler({
      now: () => nowMs,
      shouldRetry: (error) => error !== nonPausingError,
      shouldPauseAfterFailure: (error) => error !== nonPausingError,
      maxConsecutiveFailures: 1,
      run: async (_key, payload) => {
        attempts.push(payload.value);
        if (shouldFail) throw nonPausingError;
      },
    });

    expect(scheduler.enqueue('profile', { materialFingerprint: 'fp', value: 'initial' }).type).toBe('accepted');
    await vi.runAllTimersAsync();
    expect(attempts).toEqual(['initial']);

    shouldFail = false;
    expect(scheduler.enqueue('profile', { materialFingerprint: 'fp', value: 'same-material' }).type).toBe('accepted');
    await vi.runAllTimersAsync();

    expect(attempts).toEqual(['initial', 'same-material']);
  });

  it('reports timeout state when in-flight persistence has not drained', async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const never = createDeferred<void>();
    const scheduler = createScheduler({
      now: () => nowMs,
      run: async () => {
        await never.promise;
      },
    });

    scheduler.enqueue('profile', { materialFingerprint: 'fp', value: 'initial' });
    const flushed = scheduler.flushAll(25);
    await vi.advanceTimersByTimeAsync(25);

    await expect(flushed).resolves.toEqual({ timedOut: true, drained: false });
  });

  it('bounds paused same-fingerprint payload retention by maxKeys', async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const scheduler = createScheduler({
      now: () => nowMs,
      maxKeys: 3,
      maxConsecutiveFailures: 1,
      run: async () => {
        throw new Error('retryable');
      },
    });

    for (let index = 0; index < 10; index += 1) {
      scheduler.enqueue(`profile-${index}`, { materialFingerprint: `fp-${index}`, value: `value-${index}` });
      await vi.advanceTimersByTimeAsync(0);
      nowMs += 1;
    }

    expect(scheduler.getStats().retainedKeyCount).toBeLessThanOrEqual(3);
  });
});
