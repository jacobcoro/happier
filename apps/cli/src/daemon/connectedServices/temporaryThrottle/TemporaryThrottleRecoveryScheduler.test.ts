import { describe, expect, it, vi } from 'vitest';
import { TemporaryThrottleRecoveryScheduler as RecoveryScheduler, type TemporaryThrottleRecoveryIntent } from './TemporaryThrottleRecoveryScheduler';
import type { DurableRecoveryStore } from '../recoveryScheduler/DurableBackoffRecoveryScheduler';

describe('capacity failure recovery', () => {
  it.each(['capacity', 'temporary_throttle'] as const)('honors current retry limits when manually waking a legacy exhausted %s record', async (recoveryKind) => {
    let stored: unknown = { v: 1, status: 'exhausted', issueFingerprint: 'legacy:origin:old-turn', armedAtMs: 1,
      nextRetryAtMs: null, retryAfterMs: null, resetAtMs: null, attemptCount: 3, maxAttempts: 3, lastError: 'max_attempts_exhausted',
      continuation: { interruptedOriginId: 'old-turn', resumePromptMode: 'standard', customResumePrompt: null, recoveryKind },
    };
    let continued = false;
    const scheduler = new RecoveryScheduler({ nowMs: () => 1_000, random: () => 0.5,
      store: { read: () => stored, write: (_id, intent) => { stored = intent; } },
      resume: async () => { continued = true; return { status: 'continued' }; },
    });
    try {
      const result = await scheduler.retryNow({ sessionId: 'legacy' });
      expect(result.status).toBe(recoveryKind === 'capacity' ? 'resumed' : 'exhausted');
      expect(continued).toBe(recoveryKind === 'capacity');
      expect(scheduler.read('legacy')?.maxAttempts).toBe(recoveryKind === 'capacity' ? 0 : 3);
    } finally { scheduler.dispose(); }
  });

  it('rejects stale Stop identity inside the durable transaction when a newer recovery arrives', async () => {
    let current: TemporaryThrottleRecoveryIntent | null = null;
    let replacement: TemporaryThrottleRecoveryIntent | null = null;
    const store: DurableRecoveryStore<TemporaryThrottleRecoveryIntent> = {
      read: () => current, write: (_id, intent) => { current = intent; },
      transact: async (_id, transaction) => {
        if (replacement) { current = replacement; replacement = null; }
        const outcome = transaction({ intent: current, effectClaimToken: null });
        current = outcome.intent;
        return outcome.result;
      },
    };
    const scheduler = new RecoveryScheduler({ nowMs: () => 1_000, random: () => 0.5, store });
    try {
      await scheduler.enable({ sessionId: 'capacity', issueFingerprint: 'capacity',
        continuation: { interruptedOriginId: 'turn', resumePromptMode: 'standard', recoveryKind: 'capacity' },
      });
      const original = scheduler.read('capacity')!;
      replacement = { ...original, issueFingerprint: 'capacity:origin:newer', armedAtMs: 2_000 };
      expect(await scheduler.stopRetrying({ sessionId: 'capacity', issueFingerprint: original.issueFingerprint, armedAtMs: original.armedAtMs })).toBeNull();
      expect(scheduler.read('capacity')).toMatchObject({ status: 'waiting', issueFingerprint: 'capacity:origin:newer', armedAtMs: 2_000 });
    } finally { scheduler.dispose(); }
  });

  it('does not reinterpret a legacy cancelled handoff record as a new explicit Stop', async () => {
    // Pre-change v1 handoff success was persisted as cancelled, indistinguishable from Stop.
    const legacy = { v: 1, status: 'cancelled', issueFingerprint: 'capacity:origin:old-turn', armedAtMs: 1,
      nextRetryAtMs: null, retryAfterMs: null, resetAtMs: null, attemptCount: 1, maxAttempts: 3, lastError: null,
      continuation: { interruptedOriginId: 'old-turn', resumePromptMode: 'standard', customResumePrompt: null, recoveryKind: 'capacity' },
    };
    let stored: unknown = legacy;
    const scheduler = new RecoveryScheduler({ nowMs: () => 1_000, random: () => 0.5,
      store: { read: () => stored, write: (_id, intent) => { stored = intent; } },
    });
    try {
      expect(await scheduler.enable({ sessionId: 'capacity', issueFingerprint: 'capacity',
        continuation: { interruptedOriginId: 'new-turn', resumePromptMode: 'standard', recoveryKind: 'capacity' },
      })).toMatchObject({ status: 'waiting', nextRetryAtMs: 6_000 });
    } finally { scheduler.dispose(); }
  });

  it('lets Retry now bypass only local backoff and accepts only later provider floors on duplicate reports', async () => {
    let nowMs = 1_000;
    let continuations = 0;
    const scheduler = new RecoveryScheduler({ nowMs: () => nowMs, random: () => 0.5,
      resume: async () => { continuations += 1; return { status: 'continued' }; },
    });
    const enable = { sessionId: 'capacity', issueFingerprint: 'capacity', retryAfterMs: 20_000,
      continuation: { interruptedOriginId: 'turn', resumePromptMode: 'standard' as const, recoveryKind: 'capacity' as const },
    };
    try {
      await scheduler.enable(enable);
      expect(await scheduler.retryNow({ sessionId: 'capacity' })).toEqual({ status: 'waiting' });
      expect(continuations).toBe(0);
      nowMs = 2_000;
      expect(await scheduler.enable(enable)).toMatchObject({ nextRetryAtMs: 21_000 });
      expect(await scheduler.enable({ ...enable, retryAfterMs: null })).toMatchObject({ nextRetryAtMs: 21_000 });
      expect(await scheduler.enable({ ...enable, retryAfterMs: 30_000 })).toMatchObject({ nextRetryAtMs: 31_000 });
      nowMs = 31_000;
      expect(await scheduler.retryNow({ sessionId: 'capacity' })).toEqual({ status: 'resumed' });
      expect(continuations).toBe(1);
    } finally { scheduler.dispose(); }
  });

  it('preserves the failure streak when newer user input supersedes the continuation', async () => {
    const scheduler = new RecoveryScheduler({ nowMs: () => 1_000, random: () => 0.5,
      resume: async () => ({ status: 'superseded', reason: 'newer_user_input' }),
    });
    const enable = { sessionId: 'capacity', issueFingerprint: 'capacity',
      continuation: { interruptedOriginId: 'turn', resumePromptMode: 'standard' as const, recoveryKind: 'capacity' as const },
    };
    try {
      await scheduler.enable(enable);
      await scheduler.retryNow({ sessionId: 'capacity' });
      expect(await scheduler.enable({ ...enable, continuation: { ...enable.continuation, interruptedOriginId: 'next-turn' } }))
        .toMatchObject({ nextRetryAtMs: 11_000 });
    } finally { scheduler.dispose(); }
  });

  it('publishes durable capacity transitions including handoff and cancellation with the actual auth selection', async () => {
    const transitions: string[] = [];
    const records = new Map<string, unknown>();
    const scheduler = new RecoveryScheduler({ nowMs: () => 1_000, random: () => 0.5,
      store: { read: (id) => records.get(id) ?? null, write: (id, intent) => { records.set(id, intent); } },
      onStateChange: async (id, intent) => {
        expect(records.get(id)).toEqual(intent);
        if (intent) transitions.push(intent.status);
      },
      resume: async () => ({ status: 'continued' }),
    });
    try {
      await scheduler.enable({ sessionId: 'capacity', issueFingerprint: 'capacity', serviceId: 'openai-codex', profileId: 'real-profile', groupId: null,
        continuation: { interruptedOriginId: 'turn', resumePromptMode: 'standard', recoveryKind: 'capacity' },
      });
      await scheduler.retryNow({ sessionId: 'capacity' });
      await scheduler.stopRetrying({ sessionId: 'capacity' });
      expect(transitions).toEqual(['waiting', 'checking', 'awaiting_outcome', 'cancelled']);
      expect(scheduler.read('capacity')).toMatchObject({ serviceId: 'openai-codex', profileId: 'real-profile', groupId: null });
    } finally { scheduler.dispose(); }
  });

  it('keeps failed capacity continuation handoffs on the capacity backoff instead of a one-second loop', async () => {
    const scheduler = new RecoveryScheduler({ nowMs: () => 1_000, random: () => 0.5,
      resume: async () => { throw new Error('transport unavailable'); },
    });
    try {
      await scheduler.enable({ sessionId: 'capacity', issueFingerprint: 'capacity',
        continuation: { interruptedOriginId: 'turn', resumePromptMode: 'standard', recoveryKind: 'capacity' },
      });
      await scheduler.retryNow({ sessionId: 'capacity' });
      expect(scheduler.read('capacity')).toMatchObject({ status: 'waiting', nextRetryAtMs: 11_000 });
    } finally { scheduler.dispose(); }
  });

  it('retains the streak after hydration and Stop prevents a handed-off occurrence from rearming', async () => {
    const records = new Map<string, unknown>();
    const store = { read: (id: string) => records.get(id) ?? null, readAll: () => [...records.entries()],
      write: (id: string, value: unknown) => { records.set(id, value); },
    };
    const enable = { sessionId: 'capacity', issueFingerprint: 'capacity',
      continuation: { interruptedOriginId: 'turn', resumePromptMode: 'standard' as const, recoveryKind: 'capacity' as const },
    };
    const first = new RecoveryScheduler({ nowMs: () => 1_000, random: () => 0.5, store, resume: async () => ({ status: 'continued' }) });
    await first.enable(enable);
    await first.retryNow({ sessionId: 'capacity' });
    expect(first.read('capacity')?.status).toBe('awaiting_outcome');
    first.dispose();
    const resumedOrigins: string[] = [];
    const restarted = new RecoveryScheduler({ nowMs: () => 1_000, random: () => 0.5, store,
      resume: async (intent) => { resumedOrigins.push(intent.continuation!.interruptedOriginId); return { status: 'continued' }; },
    });
    try {
      restarted.hydrate();
      await restarted.stopRetrying({ sessionId: 'capacity' });
      expect(await restarted.enable(enable)).toMatchObject({ status: 'cancelled', nextRetryAtMs: null });
      expect(await restarted.enable({ ...enable, continuation: { ...enable.continuation, interruptedOriginId: 'next-turn' } }))
        .toMatchObject({ status: 'cancelled', nextRetryAtMs: null });
      expect(restarted.read('capacity')?.continuation?.interruptedOriginId).toBe('next-turn');
      expect(await restarted.retryNow({ sessionId: 'capacity' })).toEqual({ status: 'resumed' });
      expect(resumedOrigins).toEqual(['next-turn']);
      expect(restarted.read('capacity')!.armedAtMs).toBeGreaterThan(1_000);
    } finally { restarted.dispose(); }
  });

  it('backs off consecutive failed turns across successful handoffs until actual completion, without an attempt limit', async () => {
    let nowMs = 1_000;
    const scheduler = new RecoveryScheduler({ nowMs: () => nowMs, random: () => 0.5,
      resume: async () => ({ status: 'continued' }),
    });
    const enable = (origin: string, timing = {}) => scheduler.enable({
      sessionId: 'capacity-session', issueFingerprint: 'capacity', ...timing,
      continuation: { interruptedOriginId: origin, resumePromptMode: 'standard', recoveryKind: 'capacity' },
    });
    try {
      for (const [index, delay] of [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000].entries()) {
        const result = await enable(`turn-${index}`);
        expect(result.nextRetryAtMs).toBe(nowMs + delay);
        expect((await enable(`turn-${index}`)).nextRetryAtMs).toBe(result.nextRetryAtMs);
        nowMs += delay;
        expect(await scheduler.wake({ sessionId: 'capacity-session', reason: 'timer' })).toEqual({ status: 'resumed' });
      }
      await scheduler.recordTurnLifecycle({ sessionId: 'capacity-session', event: 'assistant_message_start' });
      await scheduler.recordTurnLifecycle({ sessionId: 'capacity-session', event: 'assistant_message_end', terminalStatus: 'failed' });
      expect((await enable('still-failing')).nextRetryAtMs).toBe(nowMs + 300_000);
      await scheduler.recordTurnLifecycle({ sessionId: 'capacity-session', event: 'assistant_message_end', terminalStatus: 'completed', observedAtMs: nowMs - 1 });
      expect(scheduler.read('capacity-session')?.capacityFailureCount).toBe(10);
      await scheduler.recordTurnLifecycle({ sessionId: 'capacity-session', event: 'assistant_message_end', terminalStatus: 'completed' });
      expect(scheduler.read('capacity-session')).toBeNull();
      expect((await enable('after-success')).nextRetryAtMs).toBe(nowMs + 5_000);
      await scheduler.stopRetrying({ sessionId: 'capacity-session' });
      expect(await scheduler.wake({ sessionId: 'capacity-session', reason: 'timer' })).toEqual({ status: 'inactive' });
    } finally { scheduler.dispose(); }
  });

  it.each([0, 1])('jitters capacity backoff by at most twenty percent and honors all provider timing floors (random=%s)', async (random) => {
    const scheduler = new RecoveryScheduler({ nowMs: () => 1_000, random: () => random });
    const continuation = { interruptedOriginId: 'turn', resumePromptMode: 'standard' as const, recoveryKind: 'capacity' as const };
    try {
      expect((await scheduler.enable({ sessionId: 'jitter', issueFingerprint: 'capacity', continuation })).nextRetryAtMs)
        .toBe(1_000 + (random === 0 ? 4_000 : 6_000));
      expect((await scheduler.enable({ sessionId: 'floor', issueFingerprint: 'capacity', continuation, retryAfterMs: 60_000, resetAtMs: 3_000 })).nextRetryAtMs)
        .toBe(61_000);
    } finally { scheduler.dispose(); }
  });
});

type TemporaryThrottleModule = Readonly<{
  TemporaryThrottleRecoveryScheduler: new (deps: {
    nowMs: () => number;
    jitterMs?: () => number;
    baseBackoffMs?: number;
    maxBackoffMs?: number;
    retry?: (intent: unknown, context: { sessionId: string }) => Promise<{
      status: 'ready' | 'wait' | 'exhausted';
      retryAfterMs?: number | null;
      lastError?: string | null;
    }>;
    resume?: (intent: unknown) => Promise<
      | { status: 'continued' }
      | { status: 'superseded'; reason: string }
      | { status: 'terminal'; lastError: string }
    >;
    store?: {
      read: (sessionId: string) => unknown | null;
      readAll?: () => ReadonlyArray<readonly [sessionId: string, value: unknown]>;
      write: (sessionId: string, intent: unknown) => Promise<void> | void;
      remove?: (sessionId: string) => Promise<void> | void;
    };
  }) => {
    enable: (input: {
      sessionId: string;
      issueFingerprint: string;
      retryAfterMs?: number | null;
      resetAtMs?: number | null;
      maxAttempts?: number;
      continuation?: {
        interruptedOriginId: string;
        resumePromptMode: 'standard' | 'off' | 'custom';
        customResumePrompt?: string | null;
        recoveryKind: 'temporary_throttle';
      } | null;
    }) => Promise<{ status: string; nextRetryAtMs: number | null; attemptCount: number }>;
    read: (sessionId: string) => { status: string; nextRetryAtMs: number | null; attemptCount: number; issueFingerprint?: string } | null;
    wake: (input: { sessionId: string; reason: 'timer' | 'retry_now' }) => Promise<{ status: string }>;
    retryNow: (input: { sessionId: string }) => Promise<{ status: string }>;
    stopRetrying: (input: { sessionId: string }) => Promise<{ status: string } | null>;
    hydrate: () => ReadonlyArray<unknown>;
    dispose: () => void;
  };
}>;

async function loadTemporaryThrottleModule(): Promise<TemporaryThrottleModule> {
  const modulePath = './TemporaryThrottleRecoveryScheduler';
  const mod = await import(modulePath).catch(() => null);
  expect(mod).not.toBeNull();
  expect(typeof (mod as Partial<TemporaryThrottleModule> | null)?.TemporaryThrottleRecoveryScheduler).toBe('function');
  return mod as TemporaryThrottleModule;
}

describe('TemporaryThrottleRecoveryScheduler', () => {
  it('wakes from its own timer and resumes only after a ready probe', async () => {
    vi.useFakeTimers();
    try {
      const { TemporaryThrottleRecoveryScheduler } = await loadTemporaryThrottleModule();
      let nowMs = 1_000;
      const retry = vi.fn(async () => ({ status: 'ready' as const }));
      const resume = vi.fn(async () => ({ status: 'continued' as const }));
      const scheduler = new TemporaryThrottleRecoveryScheduler({
        nowMs: () => nowMs,
        retry,
        resume,
      });

      await scheduler.enable({
        sessionId: 'session-1',
        issueFingerprint: 'temporary-throttle:codex:1',
        retryAfterMs: 1_000,
      });

      nowMs = 1_999;
      await vi.advanceTimersByTimeAsync(999);
      expect(retry).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();

      nowMs = 2_000;
      await vi.advanceTimersByTimeAsync(1);
      expect(retry).toHaveBeenCalledTimes(1);
      expect(resume).toHaveBeenCalledTimes(1);
      expect(scheduler.read('session-1')?.status).toBe('cancelled');
    } finally {
      vi.useRealTimers();
    }
  });

  it('prefers a future reset timestamp over Retry-After and base backoff', async () => {
    const { TemporaryThrottleRecoveryScheduler } = await loadTemporaryThrottleModule();
    const scheduler = new TemporaryThrottleRecoveryScheduler({
      nowMs: () => 1_000,
      baseBackoffMs: 1_000,
      maxBackoffMs: 10_000,
    });

    await expect(scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'temporary-throttle:codex:no-group:profile-1',
      retryAfterMs: 60_000,
      resetAtMs: 3_000,
    })).resolves.toMatchObject({
      status: 'waiting',
      attemptCount: 0,
      nextRetryAtMs: 3_000,
    });
  });

  it('hydrates a waiting throttle passively after daemon restart and resumes exactly once on explicit retry', async () => {
    vi.useFakeTimers();
    try {
      const { TemporaryThrottleRecoveryScheduler } = await loadTemporaryThrottleModule();
      let nowMs = 1_000;
      const written = new Map<string, unknown>();
      const store = {
        read: (sessionId: string) => written.get(sessionId) ?? null,
        readAll: () => [...written.entries()],
        write: (sessionId: string, intent: unknown) => {
          written.set(sessionId, intent);
        },
        remove: (sessionId: string) => {
          written.delete(sessionId);
        },
      };

      const firstScheduler = new TemporaryThrottleRecoveryScheduler({
        nowMs: () => nowMs,
        baseBackoffMs: 1_000,
        maxBackoffMs: 10_000,
        store,
      });

      await firstScheduler.enable({
        sessionId: 'session-1',
        issueFingerprint: 'temporary-throttle:codex:no-group:profile-1',
        retryAfterMs: 2_000,
        maxAttempts: 3,
      });
      firstScheduler.dispose();

      const retry = vi.fn(async () => ({ status: 'ready' as const }));
      const resume = vi.fn(async () => ({ status: 'continued' as const }));
      const restartedScheduler = new TemporaryThrottleRecoveryScheduler({
        nowMs: () => nowMs,
        baseBackoffMs: 1_000,
        maxBackoffMs: 10_000,
        retry,
        resume,
        store,
      });

      expect(restartedScheduler.hydrate()).toHaveLength(1);
      expect(restartedScheduler.read('session-1')).toMatchObject({
        status: 'waiting',
        issueFingerprint: 'temporary-throttle:codex:no-group:profile-1',
        attemptCount: 0,
        nextRetryAtMs: 3_000,
      });

      nowMs = 3_000;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(retry).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();

      await expect(restartedScheduler.retryNow({ sessionId: 'session-1' }))
        .resolves.toEqual({ status: 'resumed' });
      expect(retry).toHaveBeenCalledTimes(1);
      expect(resume).toHaveBeenCalledTimes(1);
      expect(store.read('session-1')).toMatchObject({
        status: 'cancelled',
        nextRetryAtMs: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses Retry-After before jittered backoff and retries with bounded attempts', async () => {
    const { TemporaryThrottleRecoveryScheduler } = await loadTemporaryThrottleModule();
    let nowMs = 1_000;
    const retry = vi
      .fn()
      .mockResolvedValueOnce({ status: 'wait' as const, retryAfterMs: null })
      .mockResolvedValueOnce({ status: 'ready' as const });
    const resume = vi.fn(async () => ({ status: 'continued' as const }));
    const scheduler = new TemporaryThrottleRecoveryScheduler({
      nowMs: () => nowMs,
      baseBackoffMs: 1_000,
      maxBackoffMs: 10_000,
      jitterMs: () => 250,
      retry,
      resume,
    });

    await expect(scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'temporary-throttle:codex:1',
      retryAfterMs: 4_000,
      maxAttempts: 2,
    })).resolves.toMatchObject({
      status: 'waiting',
      nextRetryAtMs: 5_000,
      attemptCount: 0,
    });

    nowMs = 5_000;
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'timer' })).resolves.toEqual({ status: 'waiting' });
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'waiting',
      attemptCount: 1,
      nextRetryAtMs: 7_250,
    });

    nowMs = 7_250;
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'timer' })).resolves.toEqual({ status: 'resumed' });
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('supports retry now and stop retrying controls', async () => {
    const { TemporaryThrottleRecoveryScheduler } = await loadTemporaryThrottleModule();
    const retry = vi.fn(async () => ({ status: 'wait' as const, retryAfterMs: 10_000 }));
    const scheduler = new TemporaryThrottleRecoveryScheduler({
      nowMs: () => 1_000,
      retry,
    });

    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'temporary-throttle:codex:1',
      retryAfterMs: 60_000,
    });

    await expect(scheduler.retryNow({ sessionId: 'session-1' })).resolves.toEqual({ status: 'waiting' });
    expect(retry).toHaveBeenCalledTimes(1);
    await expect(scheduler.stopRetrying({ sessionId: 'session-1' })).resolves.toEqual({ status: 'cancelled' });
    expect(scheduler.read('session-1')?.status).toBe('cancelled');
  });

  it('does not resurrect a cancelled same-fingerprint throttle report', async () => {
    const { TemporaryThrottleRecoveryScheduler } = await loadTemporaryThrottleModule();
    const scheduler = new TemporaryThrottleRecoveryScheduler({
      nowMs: () => 1_000,
    });

    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'temporary-throttle:codex:1',
      retryAfterMs: 60_000,
    });
    await expect(scheduler.stopRetrying({ sessionId: 'session-1' })).resolves.toEqual({ status: 'cancelled' });

    await expect(scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'temporary-throttle:codex:1',
      retryAfterMs: 1_000,
    })).resolves.toMatchObject({
      status: 'cancelled',
      nextRetryAtMs: null,
    });
    expect(scheduler.read('session-1')?.status).toBe('cancelled');
  });

  it('reschedules bounded retry when a throttle probe fails', async () => {
    const { TemporaryThrottleRecoveryScheduler } = await loadTemporaryThrottleModule();
    let nowMs = 1_000;
    const retry = vi.fn(async () => {
      throw new Error('provider request timed out');
    });
    const scheduler = new TemporaryThrottleRecoveryScheduler({
      nowMs: () => nowMs,
      baseBackoffMs: 1_000,
      maxBackoffMs: 10_000,
      retry,
    });

    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'temporary-throttle:codex:1',
      retryAfterMs: null,
      maxAttempts: 2,
    });

    nowMs = 2_000;
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'timer' })).resolves.toEqual({ status: 'waiting' });
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'waiting',
      attemptCount: 1,
      nextRetryAtMs: 4_000,
      lastError: 'temporary_throttle_probe_failed',
    });
  });

  it('honors Retry-After returned by a throttle probe before exponential backoff', async () => {
    const { TemporaryThrottleRecoveryScheduler } = await loadTemporaryThrottleModule();
    let nowMs = 1_000;
    const retry = vi.fn(async () => ({
      status: 'wait' as const,
      retryAfterMs: 10_000,
      lastError: 'provider_retry_after',
    }));
    const scheduler = new TemporaryThrottleRecoveryScheduler({
      nowMs: () => nowMs,
      baseBackoffMs: 1_000,
      maxBackoffMs: 60_000,
      retry,
    });

    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'temporary-throttle:codex:1',
      retryAfterMs: null,
      maxAttempts: 3,
    });

    nowMs = 2_000;
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'timer' })).resolves.toEqual({ status: 'waiting' });
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'waiting',
      attemptCount: 1,
      nextRetryAtMs: 12_000,
      lastError: 'provider_retry_after',
    });
  });

  it('reschedules instead of cancelling when resume fails after a ready probe', async () => {
    const { TemporaryThrottleRecoveryScheduler } = await loadTemporaryThrottleModule();
    let nowMs = 1_000;
    const retry = vi.fn(async () => ({ status: 'ready' as const }));
    const resume = vi.fn(async (): Promise<{ status: 'continued' }> => {
      throw new Error('session respawn failed');
    });
    const scheduler = new TemporaryThrottleRecoveryScheduler({
      nowMs: () => nowMs,
      baseBackoffMs: 1_000,
      maxBackoffMs: 10_000,
      retry,
      resume,
    });

    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'temporary-throttle:codex:1',
      retryAfterMs: null,
      maxAttempts: 2,
    });

    nowMs = 2_000;
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'timer' })).resolves.toEqual({ status: 'waiting' });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'waiting',
      attemptCount: 1,
      nextRetryAtMs: 4_000,
      lastError: 'temporary_throttle_resume_failed',
    });
  });

  it('does not reset bounded retry state when the same temporary throttle is reported again', async () => {
    const { TemporaryThrottleRecoveryScheduler } = await loadTemporaryThrottleModule();
    let nowMs = 1_000;
    const retry = vi.fn(async () => ({ status: 'wait' as const, retryAfterMs: null }));
    const scheduler = new TemporaryThrottleRecoveryScheduler({
      nowMs: () => nowMs,
      baseBackoffMs: 1_000,
      maxBackoffMs: 10_000,
      retry,
    });

    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'temporary-throttle:codex:no-group:profile-1',
      retryAfterMs: null,
      maxAttempts: 3,
    });

    nowMs = 2_000;
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'timer' })).resolves.toEqual({ status: 'waiting' });
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'waiting',
      attemptCount: 1,
      nextRetryAtMs: 4_000,
    });

    nowMs = 2_500;
    await expect(scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'temporary-throttle:codex:no-group:profile-1',
      retryAfterMs: 10_000,
      maxAttempts: 3,
    })).resolves.toMatchObject({
      status: 'waiting',
      attemptCount: 1,
      nextRetryAtMs: 4_000,
    });
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'waiting',
      attemptCount: 1,
      nextRetryAtMs: 4_000,
      lastError: null,
    });
  });

  it('starts fresh when a different temporary throttle fingerprint is reported for the same session', async () => {
    const { TemporaryThrottleRecoveryScheduler } = await loadTemporaryThrottleModule();
    let nowMs = 1_000;
    const retry = vi.fn(async () => ({ status: 'wait' as const, retryAfterMs: null }));
    const scheduler = new TemporaryThrottleRecoveryScheduler({
      nowMs: () => nowMs,
      baseBackoffMs: 1_000,
      maxBackoffMs: 10_000,
      retry,
    });

    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'temporary-throttle:codex:no-group:profile-1',
      retryAfterMs: null,
      maxAttempts: 3,
    });

    nowMs = 2_000;
    await scheduler.wake({ sessionId: 'session-1', reason: 'timer' });
    expect(scheduler.read('session-1')).toMatchObject({
      issueFingerprint: 'temporary-throttle:codex:no-group:profile-1',
      attemptCount: 1,
    });

    nowMs = 2_500;
    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'temporary-throttle:codex:no-group:profile-2',
      retryAfterMs: 500,
      maxAttempts: 3,
    });

    expect(scheduler.read('session-1')).toMatchObject({
      issueFingerprint: 'temporary-throttle:codex:no-group:profile-2',
      attemptCount: 0,
      nextRetryAtMs: 3_000,
    });
  });

  it('keeps duplicate reports for one interrupted turn deduplicated but rearms a later turn', async () => {
    const { TemporaryThrottleRecoveryScheduler } = await loadTemporaryThrottleModule();
    let nowMs = 1_000;
    const scheduler = new TemporaryThrottleRecoveryScheduler({ nowMs: () => nowMs });

    const base = {
      sessionId: 'session-1',
      issueFingerprint: 'temporary-throttle:codex:no-group:profile-1',
      retryAfterMs: 60_000,
    } as const;
    const firstContinuation = {
      interruptedOriginId: 'turn-1',
      resumePromptMode: 'standard' as const,
      recoveryKind: 'temporary_throttle' as const,
    };
    await scheduler.enable({ ...base, continuation: firstContinuation });
    await scheduler.stopRetrying({ sessionId: 'session-1' });

    await expect(scheduler.enable({ ...base, continuation: firstContinuation })).resolves.toMatchObject({
      status: 'cancelled',
    });

    nowMs = 2_000;
    await expect(scheduler.enable({
      ...base,
      continuation: { ...firstContinuation, interruptedOriginId: 'turn-2' },
    })).resolves.toMatchObject({
      status: 'waiting',
      attemptCount: 0,
    });
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'waiting',
      continuation: { interruptedOriginId: 'turn-2' },
    });
  });

  it('removes a recovery superseded by newer user input instead of reporting a resume', async () => {
    const { TemporaryThrottleRecoveryScheduler } = await loadTemporaryThrottleModule();
    const scheduler = new TemporaryThrottleRecoveryScheduler({
      nowMs: () => 1_000,
      retry: async () => ({ status: 'ready' as const }),
      resume: async () => ({ status: 'superseded' as const, reason: 'newer_user_input' }),
    });

    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'temporary-throttle:codex:no-group:profile-1',
      retryAfterMs: 0,
      continuation: {
        interruptedOriginId: 'turn-1',
        resumePromptMode: 'standard',
        recoveryKind: 'temporary_throttle',
      },
    });

    await expect(scheduler.retryNow({ sessionId: 'session-1' })).resolves.toEqual({ status: 'superseded' });
    expect(scheduler.read('session-1')).toBeNull();
  });

});
