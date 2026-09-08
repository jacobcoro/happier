import { afterEach, describe, expect, it, vi } from 'vitest';

import { accountSettingsParse } from '@happier-dev/protocol';

import { PermissionRequestPushNotifier } from './permissionRequestPushNotifier';
import type { PermissionRequestPushSender } from './permissionRequestPush';

describe('PermissionRequestPushNotifier', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers full questions and choices through the notifier', async () => {
    const sendToAllDevicesAsync = vi.fn<PermissionRequestPushSender['sendToAllDevicesAsync']>(async () => {});
    const notifier = new PermissionRequestPushNotifier({
      pushSender: { sendToAllDevicesAsync },
      getSettings: () => accountSettingsParse({ notificationsSettingsV1: { requestIncludeMessageText: true } }),
      sessionId: 's1', logPrefix: '[test]',
    });
    notifier.notify({ permissionId: 'q1', toolName: 'AskUserQuestion', toolInput: {
      questions: [{ question: 'Which environments should be updated?', multiSelect: true,
        options: [{ label: 'Production', description: 'Customer-facing deployment' }, { label: 'Staging' }],
        freeform: {} }],
    } });
    await vi.waitFor(() => expect(sendToAllDevicesAsync).toHaveBeenCalled());
    const body = sendToAllDevicesAsync.mock.calls[0][1];
    for (const text of ['Which environments should be updated?', 'Production', 'Customer-facing deployment', 'Staging', 'Select multiple', 'Custom answer']) expect(body).toContain(text);
    notifier.dispose();
  });

  it('does not send when disabled by settings', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const notifier = new PermissionRequestPushNotifier({
      pushSender: { sendToAllDevicesAsync },
      getSettings: () =>
        accountSettingsParse({
          notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: false },
        }),
      sessionId: 's1',
      logPrefix: '[test]',
      retryDelaysMs: [0],
      maxRetryMs: 10_000,
      maxEntries: 10,
    });

    notifier.notify({ permissionId: 'p1', toolName: 'Write' });
    await Promise.resolve();
    await Promise.resolve();
    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    notifier.dispose();
  });

  it('does not send user-action requests when disabled by settings', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const notifier = new PermissionRequestPushNotifier({
      pushSender: { sendToAllDevicesAsync },
      getSettings: () =>
        accountSettingsParse({
          notificationsSettingsV1: {
            v: 1,
            pushEnabled: true,
            ready: true,
            permissionRequest: true,
            userActionRequest: false,
          },
        }),
      sessionId: 's1',
      logPrefix: '[test]',
      retryDelaysMs: [0],
      maxRetryMs: 10_000,
      maxEntries: 10,
    });

    notifier.notify({ permissionId: 'p1', toolName: 'AskUserQuestion', requestKind: 'user_action' });
    await Promise.resolve();
    await Promise.resolve();
    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    notifier.dispose();
  });

  it('sends user-action requests even when permission-request pushes are disabled', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const notifier = new PermissionRequestPushNotifier({
      pushSender: { sendToAllDevicesAsync },
      getSettings: () =>
        accountSettingsParse({
          notificationsSettingsV1: {
            v: 1,
            pushEnabled: true,
            ready: true,
            permissionRequest: false,
            userActionRequest: true,
          },
        }),
      sessionId: 's1',
      getSessionTitle: () => 'Research plan',
      getAgentDisplayName: () => 'Codex',
      logPrefix: '[test]',
      retryDelaysMs: [0],
      maxRetryMs: 10_000,
      maxEntries: 10,
    });

    notifier.notify({ permissionId: 'p1', toolName: 'AskUserQuestion', requestKind: 'user_action' });
    await Promise.resolve();
    await Promise.resolve();
    expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1);
    expect(sendToAllDevicesAsync).toHaveBeenCalledWith(
      'Research plan',
      expect.stringContaining('Codex needs your input for AskUserQuestion'),
      expect.objectContaining({ sessionId: 's1', requestId: 'p1', kind: 'user_action' }),
    );
    notifier.dispose();
  });

  it('retries after failures and marks completion', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const sendToAllDevicesAsync = vi
      .fn<PermissionRequestPushSender['sendToAllDevicesAsync']>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('still offline'))
      .mockResolvedValueOnce(undefined);

    const onNotifiedAt = vi.fn();
    const notifier = new PermissionRequestPushNotifier({
      pushSender: { sendToAllDevicesAsync },
      getSettings: () =>
        accountSettingsParse({
          notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: true },
        }),
      sessionId: 's1',
      logPrefix: '[test]',
      retryDelaysMs: [100, 200],
      maxRetryMs: 10_000,
      maxEntries: 10,
      onNotifiedAt,
    });

    notifier.notify({ permissionId: 'p1', toolName: 'Write', createdAtMs: 0 });

    // First attempt runs immediately (async; no timer).
    await Promise.resolve();
    await Promise.resolve();
    expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1);

    // Advance to first retry.
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();
    await Promise.resolve();
    expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(2);

    // Advance to second retry, which succeeds.
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    await Promise.resolve();
    expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(3);
    expect(onNotifiedAt).toHaveBeenCalledTimes(1);

    notifier.markCompleted('p1');
    notifier.dispose();
  });

  it('still sends when maxEntries is configured to 0 (clamped to 1)', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const notifier = new PermissionRequestPushNotifier({
      pushSender: { sendToAllDevicesAsync },
      getSettings: () =>
        accountSettingsParse({
          notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: true },
        }),
      sessionId: 's1',
      logPrefix: '[test]',
      retryDelaysMs: [],
      maxRetryMs: 10_000,
      maxEntries: 0,
    });

    notifier.notify({ permissionId: 'p1', toolName: 'Write' });
    await Promise.resolve();
    await Promise.resolve();
    expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1);
    notifier.dispose();
  });
});
