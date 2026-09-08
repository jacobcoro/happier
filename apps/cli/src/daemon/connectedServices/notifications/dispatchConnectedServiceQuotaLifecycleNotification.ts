import type { AccountSettings } from '@happier-dev/protocol';

import { dispatchActivityNotificationAsync } from '@/activity/notifications/dispatchActivityNotification';
import type { ExpoPushActivityNotificationSender } from '@/activity/notifications/sendExpoPushActivityNotification';
import type { AutomaticQuotaResetConsumedEvent, ConnectedServiceQuotaLifecycleTransition } from '../quotas/ConnectedServiceQuotasCoordinator';
import { resolveConnectedServiceNotificationServiceDisplayName } from './connectedServiceNotificationLabels';

export async function dispatchConnectedServiceAutomaticQuotaResetNotificationAsync(params: Readonly<{
  settings: AccountSettings | null | undefined;
  settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
  expoPushSender?: ExpoPushActivityNotificationSender | null;
  event: AutomaticQuotaResetConsumedEvent;
  nowMs?: () => number;
  dedupeWindowMs?: number;
}>): Promise<void> {
  const { event } = params;
  await dispatchActivityNotificationAsync({
    ...params,
    event: {
      topic: 'connected_service_quota_recovered',
      recoveryReason: 'automatic_quota_reset',
      sessionId: event.sessionId,
      serviceId: event.serviceId,
      serviceDisplayName: resolveConnectedServiceNotificationServiceDisplayName(event.serviceId),
      groupId: event.groupId,
      profileId: event.profileId,
      issueFingerprint: event.receipt.idempotencyKey,
    },
  });
}

/**
 * RD-QUO-13: notification producer for the quota lifecycle edges. Maps an
 * edge-triggered coordinator transition onto the (already-plumbed)
 * `connected_service_quota_blocked` / `connected_service_quota_recovered`
 * topics, one event per affected group-bound session. Channel gating and
 * dedupe stay inside `dispatchActivityNotificationAsync`.
 */
export async function dispatchConnectedServiceQuotaLifecycleNotificationAsync(params: Readonly<{
  settings: AccountSettings | null | undefined;
  settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
  expoPushSender?: ExpoPushActivityNotificationSender | null;
  transition: ConnectedServiceQuotaLifecycleTransition;
  nowMs?: () => number;
  dedupeWindowMs?: number;
}>): Promise<void> {
  const transition = params.transition;
  const topic = transition.phase === 'blocked'
    ? ('connected_service_quota_blocked' as const)
    : ('connected_service_quota_recovered' as const);
  const nowMs = (params.nowMs ?? (() => Date.now()))();
  const retryAfterMs =
    typeof transition.resetAtMs === 'number' && Number.isFinite(transition.resetAtMs) && transition.resetAtMs > nowMs
      ? Math.trunc(transition.resetAtMs - nowMs)
      : null;

  for (const sessionId of transition.sessionIds) {
    await dispatchActivityNotificationAsync({
      settings: params.settings,
      settingsSecretsReadKeys: params.settingsSecretsReadKeys,
      expoPushSender: params.expoPushSender,
      event: {
        topic,
        sessionId,
        serviceId: transition.serviceId,
        serviceDisplayName: resolveConnectedServiceNotificationServiceDisplayName(transition.serviceId),
        issueFingerprint: transition.issueFingerprint,
        groupId: transition.groupId,
        profileId: transition.activeProfileId,
        limitCategory: 'usage_limit',
        retryAfterMs,
      },
      nowMs: params.nowMs,
      dedupeWindowMs: params.dedupeWindowMs,
    });
  }
}
