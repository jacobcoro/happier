import { describe, expect, it } from 'vitest';
import { NotificationChannelsV1Schema } from './notificationChannels.js';

import {
  accountSettingsParse,
  BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
  resolveNotificationChannelsV1FromAccountSettings,
} from './accountSettings.js';

describe('notificationChannelsV1', () => {
  it('derives the builtin expo push channel from legacy notification settings when explicit channels are missing', () => {
    const parsed = accountSettingsParse({
      notificationsSettingsV1: {
        v: 1,
        pushEnabled: true,
        ready: false,
        readyIncludeMessageText: false,
        requestIncludeMessageText: true,
        permissionRequest: true,
        userActionRequest: false,
        foregroundBehavior: 'full',
      },
    });

    expect(resolveNotificationChannelsV1FromAccountSettings(parsed)).toEqual([
      {
        v: 1,
        id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
        kind: 'expo_push',
        enabled: true,
        topics: {
          ready: false,
          permissionRequest: true,
          userActionRequest: false,
          connectedServiceAccountSwitch: true,
          connectedServiceQuotaBlocked: true,
          connectedServiceQuotaRecovered: true,
        },
        readyIncludeMessageText: false,
        requestIncludeMessageText: true,
      },
    ]);
  });

  it('prefers explicit notification channels over legacy notification settings', () => {
    const parsed = accountSettingsParse({
      notificationsSettingsV1: {
        v: 1,
        pushEnabled: true,
        ready: true,
        readyIncludeMessageText: true,
        requestIncludeMessageText: true,
        permissionRequest: true,
        userActionRequest: true,
        foregroundBehavior: 'full',
      },
      notificationChannelsV1: [
        {
          v: 1,
          id: 'webhook-primary',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/happier',
          signingSecret: {
            _isSecretValue: true,
            value: 'webhook-secret',
          },
          topics: {
            ready: true,
            permissionRequest: false,
            userActionRequest: true,
            connectedServiceAccountSwitch: false,
            connectedServiceQuotaBlocked: true,
            connectedServiceQuotaRecovered: true,
          },
          readyIncludeMessageText: false,
          requestIncludeMessageText: true,
        },
      ],
    });

    expect(resolveNotificationChannelsV1FromAccountSettings(parsed)).toEqual([
      {
        v: 1,
        id: 'webhook-primary',
        kind: 'webhook',
        enabled: true,
        url: 'https://hooks.example.test/happier',
        signingSecret: {
          _isSecretValue: true,
          value: 'webhook-secret',
        },
        topics: {
          ready: true,
          permissionRequest: false,
          userActionRequest: true,
          connectedServiceAccountSwitch: false,
          connectedServiceQuotaBlocked: true,
          connectedServiceQuotaRecovered: true,
        },
        readyIncludeMessageText: false,
        requestIncludeMessageText: true,
      },
    ]);
  });

  it('treats an explicit empty notification channel list as authoritative', () => {
    const parsed = accountSettingsParse({
      notificationsSettingsV1: {
        v: 1,
        pushEnabled: true,
        ready: true,
        readyIncludeMessageText: true,
        requestIncludeMessageText: true,
        permissionRequest: true,
        userActionRequest: true,
        foregroundBehavior: 'full',
      },
      notificationChannelsV1: [],
    });

    expect(resolveNotificationChannelsV1FromAccountSettings(parsed)).toEqual([]);
  });

  it('falls back to the derived builtin expo channel when explicit notification channels are malformed', () => {
    const parsed = accountSettingsParse({
      notificationsSettingsV1: {
        v: 1,
        pushEnabled: true,
        ready: false,
        readyIncludeMessageText: false,
        requestIncludeMessageText: true,
        permissionRequest: true,
        userActionRequest: true,
        foregroundBehavior: 'full',
      },
      notificationChannelsV1: [
        {
          v: 1,
          id: '',
          kind: 'webhook',
          url: 'not-a-url',
        },
      ],
    });

    expect(resolveNotificationChannelsV1FromAccountSettings(parsed)).toEqual([
      {
        v: 1,
        id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
        kind: 'expo_push',
        enabled: true,
        topics: {
          ready: false,
          permissionRequest: true,
          userActionRequest: true,
          connectedServiceAccountSwitch: true,
          connectedServiceQuotaBlocked: true,
          connectedServiceQuotaRecovered: true,
        },
        readyIncludeMessageText: false,
        requestIncludeMessageText: true,
      },
    ]);
  });

  it('rejects non-http webhook URLs and falls back to the derived builtin expo channel', () => {
    const parsed = accountSettingsParse({
      notificationsSettingsV1: {
        v: 1,
        pushEnabled: true,
        ready: true,
        readyIncludeMessageText: true,
        requestIncludeMessageText: true,
        permissionRequest: true,
        userActionRequest: true,
        foregroundBehavior: 'full',
      },
      notificationChannelsV1: [
        {
          v: 1,
          id: 'webhook-primary',
          kind: 'webhook',
          url: 'ftp://hooks.example.test/happier',
        },
      ],
    });

    expect(resolveNotificationChannelsV1FromAccountSettings(parsed)).toEqual([
      {
        v: 1,
        id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
        kind: 'expo_push',
        enabled: true,
        topics: {
          ready: true,
          permissionRequest: true,
          userActionRequest: true,
          connectedServiceAccountSwitch: true,
          connectedServiceQuotaBlocked: true,
          connectedServiceQuotaRecovered: true,
        },
        readyIncludeMessageText: true,
        requestIncludeMessageText: true,
      },
    ]);
  });

  it('defaults connected-service topics on explicit channels', () => {
    const parsed = accountSettingsParse({
      notificationChannelsV1: [
        {
          v: 1,
          id: 'webhook-primary',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/happier',
          topics: {
            ready: false,
            permissionRequest: false,
            userActionRequest: false,
          },
        },
      ],
    });

    expect(resolveNotificationChannelsV1FromAccountSettings(parsed)[0]?.topics).toEqual({
      ready: false,
      permissionRequest: false,
      userActionRequest: false,
      connectedServiceAccountSwitch: true,
      connectedServiceQuotaBlocked: true,
      connectedServiceQuotaRecovered: true,
    });
  });

  it('defaults quota recovered channel topics from quota blocked channel topics', () => {
    const parsed = accountSettingsParse({
      notificationChannelsV1: [
        {
          v: 1,
          id: 'webhook-primary',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/happier',
          topics: {
            ready: true,
            permissionRequest: true,
            userActionRequest: true,
            connectedServiceQuotaBlocked: false,
          },
        },
      ],
    });

    expect(resolveNotificationChannelsV1FromAccountSettings(parsed)[0]?.topics).toEqual({
      ready: true,
      permissionRequest: true,
      userActionRequest: true,
      connectedServiceAccountSwitch: true,
      connectedServiceQuotaBlocked: false,
      connectedServiceQuotaRecovered: false,
    });
  });
});


describe('request preview privacy', () => {
  it('shows existing webhook previews unless explicitly disabled', () => {
    const channel = { v: 1, id: 'private-hook', kind: 'webhook', url: 'https://hooks.example.test' };
    expect(NotificationChannelsV1Schema.parse([channel])[0].requestIncludeMessageText).toBe(true);
    expect(NotificationChannelsV1Schema.parse([{ ...channel, requestIncludeMessageText: false }])[0].requestIncludeMessageText).toBe(false);
  });
});
