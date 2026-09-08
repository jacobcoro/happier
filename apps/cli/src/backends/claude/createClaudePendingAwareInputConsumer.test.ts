import { describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';

import { createClaudePendingAwareInputConsumer } from './createClaudePendingAwareInputConsumer';
import type { EnhancedMode } from './loop';
import type { Session } from './session';

function createSessionHarness(accountSettings: Record<string, unknown> | null) {
  const materializeNextPendingMessageSafely = vi.fn(async () => ({ type: 'no_pending' as const }));
  const readRuntimeActivitySnapshotTail = vi.fn(() => ({
    sequence: 4,
    custody: null,
    settlement: {
      identity: {
        mutationKey: 'activity-idle-3',
        admissionOrder: 3,
      },
      desiredValue: { state: 'idle' as const, activeCount: 0 },
      result: 'applied' as const,
      committedProjection: {
        state: 'idle' as const,
        activeCount: 0,
        observedAt: 100,
        revision: 41,
      },
      committedRevision: 41,
    },
  }));
  const session = {
    queue: new MessageQueue2<EnhancedMode>(() => 'mode'),
    accountSettings,
    registerProviderInputConsumer: vi.fn(),
    client: {
      materializeNextPendingMessageSafely,
      readRuntimeActivitySnapshotTail,
      waitForRuntimeActivitySnapshotTailChange: vi.fn(async () => false),
      popPendingMessage: vi.fn(async () => false),
      shouldAttemptPendingMaterialization: vi.fn(() => true),
      reconcilePendingQueueState: vi.fn(async () => false),
      waitForPendingEligibilityUpdate: vi.fn(async () => false),
      waitForMetadataUpdate: vi.fn(async () => false),
    },
  } as unknown as Session;

  return { session, materializeNextPendingMessageSafely, readRuntimeActivitySnapshotTail };
}

describe('createClaudePendingAwareInputConsumer', () => {
  it('delivers exact resumed input with its local id intact', async () => {
    const { session } = createSessionHarness(null);
    session.queue.push('resume exactly this', { permissionMode: 'default' }, {
      userMessageLocalIds: ['claude-resumed-local-id'],
    });

    const consumer = createClaudePendingAwareInputConsumer(session);

    await expect(consumer.waitForNextInput({ abortSignal: new AbortController().signal })).resolves.toEqual(
      expect.objectContaining({
        message: 'resume exactly this',
        userMessageLocalIds: ['claude-resumed-local-id'],
      }),
    );
  });

  it('reports active Claude foreground work as unsteerable without a current capability proof', async () => {
    const { session, materializeNextPendingMessageSafely } = createSessionHarness(null);

    const consumer = createClaudePendingAwareInputConsumer(session);

    await consumer.drainPending({ reason: 'test-live-steer-default' });

    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith(expect.objectContaining({
      reconcileWhenEmpty: 'force',
      pendingQueueDeliveryTiming: 'after_foreground_ready',
    }));
  });

  it('reads the current exact unified-terminal steerability snapshot on every pending drain', async () => {
    const { session, materializeNextPendingMessageSafely } = createSessionHarness(null);
    let available = false;

    const consumer = createClaudePendingAwareInputConsumer(session, {
      resolveActiveTurnSteerability: () => available ? 'steerable' : 'unsteerable',
    });

    await consumer.drainPending({ reason: 'test-live-steer-unavailable' });
    expect(materializeNextPendingMessageSafely).toHaveBeenLastCalledWith(expect.objectContaining({
      reconcileWhenEmpty: 'force',
      activeTurnSteerability: 'unsteerable',
      pendingQueueDeliveryTiming: 'after_foreground_ready',
    }));

    available = true;
    await consumer.drainPending({ reason: 'test-live-steer-available' });
    expect(materializeNextPendingMessageSafely).toHaveBeenLastCalledWith(expect.objectContaining({
      reconcileWhenEmpty: 'force',
      activeTurnSteerability: 'steerable',
      pendingQueueDeliveryTiming: 'after_foreground_ready',
    }));
  });

  it('uses one fresh provider-owned steerability proof before each active Pending claim', async () => {
    const { session, materializeNextPendingMessageSafely } = createSessionHarness(null);
    let cachedAvailability: 'steerable' | 'unsteerable' = 'steerable';
    const refreshActiveTurnSteerability = vi.fn()
      .mockResolvedValueOnce('unsteerable' as const)
      .mockResolvedValueOnce('steerable' as const);

    const consumer = createClaudePendingAwareInputConsumer(session, {
      resolveActiveTurnSteerability: () => cachedAvailability,
      refreshActiveTurnSteerability,
    });

    await consumer.drainPending({ reason: 'test-stale-positive-pre-claim-steer-refresh' });

    expect(refreshActiveTurnSteerability).toHaveBeenCalledTimes(1);
    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith(expect.objectContaining({
      reconcileWhenEmpty: 'force',
      activeTurnSteerability: 'unsteerable',
      pendingQueueDeliveryTiming: 'after_foreground_ready',
    }));

    cachedAvailability = 'unsteerable';
    await consumer.drainPending({ reason: 'test-stale-negative-pre-claim-steer-refresh' });

    expect(refreshActiveTurnSteerability).toHaveBeenCalledTimes(2);
    expect(materializeNextPendingMessageSafely).toHaveBeenLastCalledWith(expect.objectContaining({
      reconcileWhenEmpty: 'force',
      activeTurnSteerability: 'steerable',
      pendingQueueDeliveryTiming: 'after_foreground_ready',
    }));
  });

  it('does not turn a steering preference into a current Claude capability proof', async () => {
    const { session, materializeNextPendingMessageSafely } = createSessionHarness({
      sessionBusySteerSendPolicy: 'steer_immediately',
    });

    const consumer = createClaudePendingAwareInputConsumer(session);

    await consumer.drainPending({ reason: 'test-live-steer-immediate' });

    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith(expect.objectContaining({
      reconcileWhenEmpty: 'force',
      pendingQueueDeliveryTiming: 'after_foreground_ready',
    }));
  });

  it('keeps the active-turn block when busy steering is configured as server pending', async () => {
    const { session, materializeNextPendingMessageSafely } = createSessionHarness({
      sessionBusySteerSendPolicy: 'server_pending',
    });

    const consumer = createClaudePendingAwareInputConsumer(session);

    await consumer.drainPending({ reason: 'test-server-pending' });

    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith(expect.objectContaining({
      reconcileWhenEmpty: 'force',
      pendingQueueDeliveryTiming: 'after_foreground_ready',
    }));
  });

  it('passes runtime-idle timing without manufacturing Claude steerability', async () => {
    const { session, materializeNextPendingMessageSafely, readRuntimeActivitySnapshotTail } = createSessionHarness({
      sessionPendingQueueDeliveryTiming: 'after_runtime_idle',
    });

    const consumer = createClaudePendingAwareInputConsumer(session);

    await consumer.drainPending({ reason: 'test-runtime-idle-timing' });

    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith(expect.objectContaining({
      reconcileWhenEmpty: 'force',
      pendingQueueDeliveryTiming: 'after_runtime_idle',
    }));
    expect(readRuntimeActivitySnapshotTail).not.toHaveBeenCalled();
  });

  it('reports local-input ordering backpressure as deferred instead of an empty server queue', async () => {
    const { session, materializeNextPendingMessageSafely } = createSessionHarness(null);
    const shouldAttemptPendingMaterialization = session.client.shouldAttemptPendingMaterialization;
    if (!shouldAttemptPendingMaterialization) throw new Error('missing pending materialization preflight');
    vi.mocked(shouldAttemptPendingMaterialization).mockImplementationOnce(() => {
      session.queue.pushImmediate('local-first', { permissionMode: 'default' });
      return true;
    });
    const consumer = createClaudePendingAwareInputConsumer(session);

    await expect(consumer.drainPending({ reason: 'test-local-ordering-race' })).resolves.toEqual({
      materialized: 0,
      stoppedReason: 'deferred',
    });
    expect(materializeNextPendingMessageSafely).not.toHaveBeenCalled();

    await expect(consumer.waitForNextInput({ abortSignal: new AbortController().signal })).resolves.toEqual(
      expect.objectContaining({ message: 'local-first' }),
    );
  });
});
