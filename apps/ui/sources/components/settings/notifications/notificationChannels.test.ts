import { describe, expect, it } from 'vitest';

import {
    BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
    DEFAULT_NOTIFICATION_CHANNEL_TOPICS_V1,
    DEFAULT_NOTIFICATIONS_SETTINGS_V1,
} from '@happier-dev/protocol';

import {
    addWebhookNotificationChannel,
    buildNotificationSettingsDelta,
    removeNotificationChannelById,
    updateNotificationChannelById,
} from './notificationChannels';

describe('notificationChannels helpers', () => {
    it('adds a webhook channel alongside the builtin expo channel', () => {
        const next = addWebhookNotificationChannel({
            channels: [],
            url: 'https://hooks.example.test/notify',
        });

        expect(next).toEqual([
            {
                v: 1,
                id: 'webhook-hooks-example-test-notify',
                kind: 'webhook',
                enabled: true,
                url: 'https://hooks.example.test/notify',
                signingSecret: null,
                topics: DEFAULT_NOTIFICATION_CHANNEL_TOPICS_V1,
                readyIncludeMessageText: false,
                requestIncludeMessageText: true,
            },
        ]);
    });

    it('disables webhook request previews while retaining its topics', () => {
        const channels = addWebhookNotificationChannel({ channels: [], url: 'https://hooks.example.test/private' });
        const next = updateNotificationChannelById({ channels, channelId: channels[0].id,
            patch: { requestIncludeMessageText: false } });
        expect(channels[0].requestIncludeMessageText).toBe(true);
        expect(next[0].requestIncludeMessageText).toBe(false);
        expect(next[0].topics).toEqual(channels[0].topics);
    });

    it('updates a webhook channel without changing other channels', () => {
        const next = updateNotificationChannelById({
            channels: [
                {
                    v: 1,
                    id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
                    kind: 'expo_push',
                    enabled: true,
                    topics: DEFAULT_NOTIFICATION_CHANNEL_TOPICS_V1,
                    readyIncludeMessageText: true,
                    requestIncludeMessageText: false,
                },
                {
                    v: 1,
                    id: 'webhook-primary',
                    kind: 'webhook',
                    enabled: true,
                    url: 'https://hooks.example.test/notify',
                    signingSecret: null,
                    topics: DEFAULT_NOTIFICATION_CHANNEL_TOPICS_V1,
                    readyIncludeMessageText: false,
                    requestIncludeMessageText: false,
                },
            ],
            channelId: 'webhook-primary',
            patch: {
                enabled: false,
                topics: {
                    ...DEFAULT_NOTIFICATION_CHANNEL_TOPICS_V1,
                    ready: false,
                    userActionRequest: false,
                },
            },
        });

        expect(next).toEqual([
            {
                v: 1,
                id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
                kind: 'expo_push',
                enabled: true,
                topics: DEFAULT_NOTIFICATION_CHANNEL_TOPICS_V1,
                readyIncludeMessageText: true,
                requestIncludeMessageText: false,
            },
            {
                v: 1,
                id: 'webhook-primary',
                kind: 'webhook',
                enabled: false,
                url: 'https://hooks.example.test/notify',
                signingSecret: null,
                topics: {
                    ...DEFAULT_NOTIFICATION_CHANNEL_TOPICS_V1,
                    ready: false,
                    userActionRequest: false,
                },
                readyIncludeMessageText: false,
                requestIncludeMessageText: false,
            },
        ]);
    });

    it('removes a webhook channel by id', () => {
        const next = removeNotificationChannelById({
            channels: [
                {
                    v: 1,
                    id: 'webhook-primary',
                    kind: 'webhook',
                    enabled: true,
                    url: 'https://hooks.example.test/notify',
                    signingSecret: null,
                    topics: DEFAULT_NOTIFICATION_CHANNEL_TOPICS_V1,
                    readyIncludeMessageText: false,
                    requestIncludeMessageText: false,
                },
            ],
            channelId: 'webhook-primary',
        });

        expect(next).toEqual([]);
    });

    it('builds a synced settings delta that keeps legacy expo settings mirrored', () => {
        const delta = buildNotificationSettingsDelta({
            notifications: {
                ...DEFAULT_NOTIFICATIONS_SETTINGS_V1,
                readyIncludeMessageText: false,
                requestIncludeMessageText: false,
            },
            webhookChannels: [
                {
                    v: 1,
                    id: 'webhook-primary',
                    kind: 'webhook',
                    enabled: true,
                    url: 'https://hooks.example.test/notify',
                    signingSecret: null,
                    topics: {
                        ...DEFAULT_NOTIFICATION_CHANNEL_TOPICS_V1,
                        permissionRequest: false,
                    },
                    readyIncludeMessageText: false,
                    requestIncludeMessageText: false,
                },
            ],
        });

        expect(delta).toEqual({
            notificationsSettingsV1: {
                ...DEFAULT_NOTIFICATIONS_SETTINGS_V1,
                readyIncludeMessageText: false,
                requestIncludeMessageText: false,
            },
            notificationChannelsV1: [
                {
                    v: 1,
                    id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
                    kind: 'expo_push',
                    enabled: true,
                    topics: DEFAULT_NOTIFICATION_CHANNEL_TOPICS_V1,
                    readyIncludeMessageText: false,
                    requestIncludeMessageText: false,
                },
                {
                    v: 1,
                    id: 'webhook-primary',
                    kind: 'webhook',
                    enabled: true,
                    url: 'https://hooks.example.test/notify',
                    signingSecret: null,
                    topics: {
                        ...DEFAULT_NOTIFICATION_CHANNEL_TOPICS_V1,
                        permissionRequest: false,
                    },
                    readyIncludeMessageText: false,
                    requestIncludeMessageText: false,
                },
            ],
        });
    });
});
