import { describe, expect, it } from 'vitest';
import { SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY as key } from '@happier-dev/protocol';
import { projectTemporaryThrottleRecoveryMetadata } from './temporaryThrottleRecoveryMetadata';

const intent = {
  v: 1 as const, sessionId: 's', serviceId: 'openai-codex', profileId: 'main', groupId: null,
  status: 'waiting' as const, issueFingerprint: 'temporary-throttle:main:origin:turn1',
  armedAtMs: 100, nextRetryAtMs: 5100, retryAfterMs: null, resetAtMs: null,
  attemptCount: 0, capacityFailureCount: 1, maxAttempts: 0, lastError: null, continuation: null,
};
describe('temporary throttle recovery presentation', () => {
  it('presents an unlimited superseded hold as paused while preserving finite exhaustion and Stop', () => {
    const checking = projectTemporaryThrottleRecoveryMetadata({}, { ...intent, status: 'checking', attemptCount: 1 }, null);
    const hold = { ...intent, status: 'exhausted' as const, attemptCount: 1, nextRetryAtMs: null };
    const paused = projectTemporaryThrottleRecoveryMetadata(checking, hold, intent);
    expect(paused[key]).toMatchObject({ status: 'paused', maxAttempts: 0, nextCheckAtMs: null });
    expect(projectTemporaryThrottleRecoveryMetadata({}, { ...hold, maxAttempts: 3 }, null)[key])
      .toMatchObject({ status: 'exhausted', maxAttempts: 3 });
    const stopped = projectTemporaryThrottleRecoveryMetadata(checking, { ...intent, status: 'cancelled' }, intent);
    expect(projectTemporaryThrottleRecoveryMetadata(stopped, hold, intent)[key]).toMatchObject({ status: 'cancelled' });
    expect(projectTemporaryThrottleRecoveryMetadata(paused, { ...intent, armedAtMs: 101 }, hold)[key])
      .toMatchObject({ status: 'waiting', armedAtMs: 101 });
  });
  it('projects countdown, dispatch, provider outcome wait and next capacity retry through the recovery merge', () => {
    const armed = projectTemporaryThrottleRecoveryMetadata({}, intent, null);
    expect(armed[key]).toMatchObject({ status: 'waiting', nextCheckAtMs: 5100, attemptCount: 0,
      maxAttempts: 0, selectedAuth: { kind: 'profile', serviceId: 'openai-codex', profileId: 'main' } });
    const checking = projectTemporaryThrottleRecoveryMetadata(armed, { ...intent, attemptCount: 1, status: 'checking', nextRetryAtMs: null }, intent);
    expect(checking[key]).toMatchObject({ status: 'checking', nextCheckAtMs: null });
    const waiting = projectTemporaryThrottleRecoveryMetadata(checking, { ...intent, attemptCount: 1, status: 'awaiting_outcome', nextRetryAtMs: null }, intent);
    expect(waiting[key]).toMatchObject({ status: 'waiting', nextCheckAtMs: null });
    const retry = projectTemporaryThrottleRecoveryMetadata(waiting, { ...intent, attemptCount: 1, capacityFailureCount: 2, nextRetryAtMs: 12000 }, intent);
    expect(retry[key]).toMatchObject({ status: 'waiting', attemptCount: 1, nextCheckAtMs: 12000 });
  });
  it('restores countdown after a handoff failure without changing the capacity streak', () => {
    const checkingIntent = { ...intent, status: 'checking' as const, attemptCount: 1, nextRetryAtMs: null };
    const checking = projectTemporaryThrottleRecoveryMetadata({}, checkingIntent, null);
    const retryIntent = { ...checkingIntent, status: 'waiting' as const, nextRetryAtMs: 12000 };
    const retry = projectTemporaryThrottleRecoveryMetadata(checking, retryIntent, checkingIntent);
    expect(retry[key]).toMatchObject({ status: 'waiting', attemptCount: 1, nextCheckAtMs: 12000 });
    const nextChecking = projectTemporaryThrottleRecoveryMetadata(retry, { ...checkingIntent, attemptCount: 2 }, retryIntent);
    expect(nextChecking[key]).toMatchObject({ status: 'checking', attemptCount: 2, nextCheckAtMs: null });
    expect(projectTemporaryThrottleRecoveryMetadata(nextChecking, retryIntent, checkingIntent)).toEqual(nextChecking);
  });
  it('normalizes the newer capacity fingerprint while preserving exact completion clearing', () => {
    const raw = { ...intent, issueFingerprint: 'temporary-retry:capacity:main:origin:turn1' };
    const projected = projectTemporaryThrottleRecoveryMetadata({}, raw, null);
    expect(projected[key]).toMatchObject({ issueFingerprint: 'temporary-throttle:temporary-retry:capacity:main:origin:turn1' });
    expect(projectTemporaryThrottleRecoveryMetadata(projected, null, raw)).toEqual({});
  });
  it('preserves Stop, newer quota recovery and unrelated fields, and clears only the exact completed occurrence', () => {
    const armed = projectTemporaryThrottleRecoveryMetadata({ unrelated: 42 }, intent, null);
    const stopped = projectTemporaryThrottleRecoveryMetadata(armed, { ...intent, status: 'cancelled', nextRetryAtMs: null }, intent);
    expect(projectTemporaryThrottleRecoveryMetadata(stopped, intent, intent)[key]).toMatchObject({ status: 'cancelled' });
    expect(projectTemporaryThrottleRecoveryMetadata(stopped, { ...intent, armedAtMs: 101 }, intent)[key])
      .toMatchObject({ status: 'waiting', armedAtMs: 101, nextCheckAtMs: 5100 });
    const newer = { ...armed, [key]: { ...(armed[key] as object), issueFingerprint: 'quota:new', armedAtMs: 200 } };
    expect(projectTemporaryThrottleRecoveryMetadata(newer, intent, intent)).toEqual(newer);
    expect(projectTemporaryThrottleRecoveryMetadata(newer, null, intent)).toEqual(newer);
    expect(projectTemporaryThrottleRecoveryMetadata(armed, null, intent)).toEqual({ unrelated: 42 });
  });
});
