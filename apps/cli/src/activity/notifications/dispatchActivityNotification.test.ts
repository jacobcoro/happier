import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  accountSettingsParse,
  deriveSettingsSecretsKeyV1,
  encryptSecretStringV1,
} from '@happier-dev/protocol';

import { dispatchActivityNotificationAsync } from './dispatchActivityNotification';
import type { ActivityNotificationEvent } from './activityNotificationEvent';

describe('dispatchActivityNotificationAsync', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchSpy);
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 202,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps full permission details only in channels that include request text', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const settings = accountSettingsParse({ notificationChannelsV1: [true, false, undefined].map((include, index) => ({
      v: 1, id: `hook-${index}`, kind: 'webhook', enabled: true,
      url: 'https://hooks.example.test/happier', requestIncludeMessageText: include,
      topics: { permissionRequest: true },
    })) });
    await dispatchActivityNotificationAsync({ settings, expoPushSender: { sendToAllDevicesAsync }, event: {
      topic: 'permission_request', sessionId: 's1', requestId: 'p1', toolName: 'Bash',
      toolInput: { command: 'git diff -- apps/cli/src/main.ts', justification: 'Review the complete patch' },
    } });
    const payloads = fetchSpy.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(payloads).toHaveLength(3);
    expect(payloads[0].content.body).toContain('git diff -- apps/cli/src/main.ts');
    expect(payloads[0].request.toolDetails).toContain('Review the complete patch');
    expect(payloads[1].content.body).not.toContain('git diff');
    expect(payloads[1].request.toolDetails).toBeNull();
    expect(payloads[2].request.toolDetails).toContain('Review the complete patch');
    expect(payloads[2].content.body).toContain('git diff -- apps/cli/src/main.ts');
  });

  it('falls back to the builtin expo push channel when explicit channels are missing', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const settings = accountSettingsParse({
      notificationsSettingsV1: {
        v: 1,
        pushEnabled: true,
        ready: true,
        readyIncludeMessageText: true,
        permissionRequest: true,
        userActionRequest: true,
        foregroundBehavior: 'full',
      },
    });

    await dispatchActivityNotificationAsync({
      settings,
      expoPushSender: { sendToAllDevicesAsync },
      event: {
        topic: 'ready',
        sessionId: 'session-1',
        sessionTitle: 'Review branch',
        waitingForCommandLabel: 'Codex',
        assistantPreviewText: 'The branch is ready to review.',
      },
    });

    expect(sendToAllDevicesAsync).toHaveBeenCalledWith(
      'Review branch',
      'The branch is ready to review.',
      { sessionId: 'session-1' },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('dispatches only to enabled explicit channels', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const settings = accountSettingsParse({
      notificationChannelsV1: [
        {
          v: 1,
          id: 'expo-disabled',
          kind: 'expo_push',
          enabled: false,
          topics: {
            ready: true,
            permissionRequest: true,
            userActionRequest: true,
          },
          readyIncludeMessageText: true,
        },
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
            permissionRequest: true,
            userActionRequest: true,
          },
          readyIncludeMessageText: false,
        },
      ],
    });

    await dispatchActivityNotificationAsync({
      settings,
      expoPushSender: { sendToAllDevicesAsync },
      event: {
        topic: 'ready',
        sessionId: 'session-2',
        sessionTitle: 'Deploy fix',
        waitingForCommandLabel: 'Gemini',
        assistantPreviewText: 'Deployment is complete.',
      },
    });

    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe('https://hooks.example.test/happier');
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-happier-signature-256': expect.stringMatching(/^sha256=[a-f0-9]{64}$/),
      },
    });
    const payload = JSON.parse(String(init.body));
    expect(payload.content).toEqual({
      title: 'Deploy fix',
      body: 'Gemini is waiting for your command',
    });
  });

  it('keeps request contents private on webhook channels when previews are disabled', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const settings = accountSettingsParse({
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
            ready: false,
            permissionRequest: true,
            userActionRequest: true,
          },
          readyIncludeMessageText: false,
          requestIncludeMessageText: false,
        },
      ],
    });

    await dispatchActivityNotificationAsync({
      settings,
      expoPushSender: { sendToAllDevicesAsync },
      event: {
        topic: 'permission_request',
        sessionId: 'session-3',
        sessionTitle: 'Fix prod issue',
        agentDisplayName: 'Claude',
        requestId: 'request-9',
        toolName: 'Bash',
        toolInput: { command: 'git status --short && echo secret-token' },
      },
    });

    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] ?? [];
    const payload = JSON.parse(String(init.body));
    expect(init).toMatchObject({
      headers: {
        'content-type': 'application/json',
        'x-happier-signature-256': expect.stringMatching(/^sha256=[a-f0-9]{64}$/),
      },
    });
    expect(payload.request).toMatchObject({
      requestId: 'request-9',
      kind: 'permission',
      toolName: 'Bash',
      toolDetails: null,
    });
    expect(payload.content.title).toBe('Fix prod issue');
    expect(payload.content.body).toContain('Claude asks permission to use Bash');
    expect(payload.content.body).not.toContain('Command: git');
    expect(JSON.stringify(payload)).not.toContain('secret-token');
  });

  it('decrypts encrypted webhook signing secrets when settings secret read keys are provided', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => {});
    const settingsSecretsKey = deriveSettingsSecretsKeyV1(new Uint8Array(32).fill(7));
    const settings = accountSettingsParse({
      notificationChannelsV1: [
        {
          v: 1,
          id: 'webhook-primary',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/happier',
          signingSecret: {
            _isSecretValue: true,
            encryptedValue: encryptSecretStringV1(
              'sealed-webhook-secret',
              settingsSecretsKey,
              (length) => new Uint8Array(length).fill(3),
            ),
          },
          topics: {
            ready: true,
            permissionRequest: true,
            userActionRequest: true,
          },
          readyIncludeMessageText: false,
        },
      ],
    });

    await dispatchActivityNotificationAsync({
      settings,
      settingsSecretsReadKeys: [settingsSecretsKey],
      expoPushSender: { sendToAllDevicesAsync },
      event: {
        topic: 'ready',
        sessionId: 'session-4',
        sessionTitle: 'Ship release',
        waitingForCommandLabel: 'Codex',
        assistantPreviewText: 'Release branch is ready.',
      },
    });

    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] ?? [];
    expect(init).toMatchObject({
      headers: {
        'content-type': 'application/json',
        'x-happier-signature-256': expect.stringMatching(/^sha256=[a-f0-9]{64}$/),
      },
    });
  });

  it('dispatches connected-service account switch notifications with provider display names and reason metadata when the topic is enabled', async () => {
    const settings = accountSettingsParse({
      notificationChannelsV1: [
        {
          v: 1,
          id: 'webhook-primary',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/happier',
          signingSecret: null,
          topics: {
            ready: false,
            permissionRequest: false,
            userActionRequest: false,
            connectedServiceAccountSwitch: true,
            connectedServiceQuotaBlocked: false,
            connectedServiceQuotaRecovered: false,
          },
          readyIncludeMessageText: false,
        },
      ],
    });

    await dispatchActivityNotificationAsync({
      settings,
      event: {
        topic: 'connected_service_account_switch',
        sessionId: 'session-5',
        sessionTitle: 'Continue work',
        serviceId: 'openai-codex',
        serviceDisplayName: 'OpenAI',
        groupId: 'main',
        fromProfileId: 'primary',
        toProfileId: 'backup',
        fromProfileLabel: 'primary@example.test',
        toProfileLabel: 'backup@example.test',
        reason: 'usage_limit',
        limitCategory: 'quota',
        retryAfterMs: 60_000,
        quotaScope: 'account',
        providerLimitId: 'weekly',
        action: { kind: 'open_url', url: 'https://chatgpt.com/codex/settings/usage' },
      },
      nowMs: () => 1_000,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] ?? [];
    const payload = JSON.parse(String(init.body));
    expect(payload.topic).toBe('connected_service_account_switch');
    expect(payload.content).toMatchObject({
      title: 'Continue work',
    });
    expect(payload.content.body).toContain('OpenAI');
    expect(payload.content.body).toContain('provider reported');
    expect(payload.content.body).toContain('primary@example.test');
    expect(payload.content.body).toContain('backup@example.test');
    expect(payload.content.body).not.toContain('openai-codex');
    expect(payload.session).toMatchObject({ sessionId: 'session-5' });
    expect(payload.metadata).toMatchObject({
      topic: 'connected_service_account_switch',
      serviceId: 'openai-codex',
      serviceDisplayName: 'OpenAI',
      groupId: 'main',
      fromProfileId: 'primary',
      toProfileId: 'backup',
      fromProfileLabel: 'primary@example.test',
      toProfileLabel: 'backup@example.test',
      reason: 'usage_limit',
      limitCategory: 'quota',
      retryAfterMs: 60_000,
      quotaScope: 'account',
      providerLimitId: 'weekly',
      action: { kind: 'open_url', url: 'https://chatgpt.com/codex/settings/usage' },
    });
  });

  it('dispatches connected-service credential health notifications without raw provider details', async () => {
    const settings = accountSettingsParse({
      notificationChannelsV1: [
        {
          v: 1,
          id: 'webhook-primary',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/happier',
          signingSecret: null,
          topics: {
            ready: false,
            permissionRequest: false,
            userActionRequest: false,
            connectedServiceAccountSwitch: true,
            connectedServiceQuotaBlocked: false,
            connectedServiceQuotaRecovered: false,
          },
          readyIncludeMessageText: false,
        },
      ],
    });

    await dispatchActivityNotificationAsync({
      settings,
      event: {
        topic: 'connected_service_credential_health',
        sessionId: 'session-credential',
        sessionTitle: 'Investigate auth',
        serviceId: 'openai-codex',
        serviceDisplayName: 'OpenAI',
        profileId: 'work',
        profileLabel: 'work@example.test',
        status: 'reconnect_required',
        reason: 'invalid_grant',
        providerStatus: 400,
        providerErrorCode: 'invalid_grant',
      } satisfies ActivityNotificationEvent,
      nowMs: () => 1_000,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] ?? [];
    const payload = JSON.parse(String(init.body));
    expect(payload.topic).toBe('connected_service_credential_health');
    expect(payload.content).toMatchObject({
      title: 'Investigate auth',
    });
    expect(payload.content.body).toContain('OpenAI');
    expect(payload.content.body).toContain('work@example.test');
    expect(payload.content.body).toContain('reconnect');
    expect(payload.content.body).toContain('invalid_grant');
    expect(payload.content.body).not.toContain('secret-refresh-token');
    expect(payload.metadata).toMatchObject({
      topic: 'connected_service_credential_health',
      serviceId: 'openai-codex',
      serviceDisplayName: 'OpenAI',
      profileId: 'work',
      profileLabel: 'work@example.test',
      status: 'reconnect_required',
      reason: 'invalid_grant',
      providerStatus: 400,
      providerErrorCode: 'invalid_grant',
    });
  });

  it('redacts raw connected-service diagnostic strings from notification bodies and metadata', async () => {
    const settings = accountSettingsParse({
      notificationChannelsV1: [
        {
          v: 1,
          id: 'webhook-primary',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/happier',
          signingSecret: null,
          topics: {
            ready: false,
            permissionRequest: false,
            userActionRequest: false,
            connectedServiceAccountSwitch: true,
            connectedServiceQuotaBlocked: false,
            connectedServiceQuotaRecovered: false,
          },
          readyIncludeMessageText: false,
        },
      ],
    });

    await dispatchActivityNotificationAsync({
      settings,
      event: {
        topic: 'connected_service_credential_health',
        sessionId: 'session-redacted',
        sessionTitle: 'Investigate auth',
        serviceId: 'openai-codex',
        serviceDisplayName: 'OpenAI',
        profileId: 'work',
        profileLabel: 'work@example.test',
        status: 'reconnect_required',
        reason: 'Authorization: Bearer provider-access-token',
        providerStatus: 400,
        providerErrorCode: [
          '{"error":"invalid_grant","access_token":"secret-access-token","refresh_token":"secret-refresh-token"}',
          "Cannot find module '/Users/alice/.happier/node_modules/provider-sdk/index.js'",
        ].join(' '),
      } satisfies ActivityNotificationEvent,
      nowMs: () => 1_000,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] ?? [];
    const payloadText = String(init.body);
    const payload = JSON.parse(payloadText);
    expect(payload.content.body).toContain('invalid_grant');
    expect(payload.content.body).toContain('provider runtime error');
    expect(payload.metadata.providerErrorCode).toContain('invalid_grant');
    expect(payload.metadata.providerErrorCode).toContain('provider_runtime_error');
    expect(payload.metadata.reason).toBe('authorization: bearer [REDACTED]');
    expect(payloadText).not.toContain('secret-access-token');
    expect(payloadText).not.toContain('secret-refresh-token');
    expect(payloadText).not.toContain('provider-access-token');
    expect(payloadText).not.toContain('/Users/alice/.happier/node_modules');
    expect(payloadText).not.toContain('provider-sdk/index.js');
  });

  it('does not say for this session when an account switch notification has no session title', async () => {
    const settings = accountSettingsParse({
      notificationChannelsV1: [
        {
          v: 1,
          id: 'webhook-primary',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/happier',
          signingSecret: null,
          topics: {
            ready: false,
            permissionRequest: false,
            userActionRequest: false,
            connectedServiceAccountSwitch: true,
            connectedServiceQuotaBlocked: false,
            connectedServiceQuotaRecovered: false,
          },
          readyIncludeMessageText: false,
        },
      ],
    });

    await dispatchActivityNotificationAsync({
      settings,
      event: {
        topic: 'connected_service_account_switch',
        sessionId: 'session-6',
        sessionTitle: null,
        serviceId: 'openai-codex',
        groupId: 'secondary',
        fromProfileId: 'primary',
        toProfileId: 'backup',
        reason: 'manual',
      },
      nowMs: () => 1_000,
    });

    const [, init] = fetchSpy.mock.calls[0] ?? [];
    const payload = JSON.parse(String(init.body));
    expect(payload.content).toMatchObject({
      title: 'OpenAI account switched',
    });
    expect(payload.content.body).toContain('OpenAI');
    expect(payload.content.body).not.toContain('for this session');
  });

  it('suppresses connected-service notifications when the topic is disabled', async () => {
    const settings = accountSettingsParse({
      notificationChannelsV1: [
        {
          v: 1,
          id: 'webhook-primary',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/happier',
          signingSecret: null,
          topics: {
            ready: false,
            permissionRequest: false,
            userActionRequest: false,
            connectedServiceAccountSwitch: false,
            connectedServiceQuotaBlocked: false,
            connectedServiceQuotaRecovered: false,
          },
          readyIncludeMessageText: false,
        },
      ],
    });

    const result = await dispatchActivityNotificationAsync({
      settings,
      event: {
        topic: 'connected_service_account_switch',
        sessionId: 'session-6',
        serviceId: 'openai-codex',
        groupId: 'main',
        fromProfileId: 'primary',
        toProfileId: 'backup',
        reason: 'usage_limit',
      },
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      attemptedChannels: 0,
      deliveredChannels: 0,
      suppressedChannels: 0,
    });
  });

  it('does not dedupe account switch notifications with different reasons or target profiles', async () => {
    const settings = accountSettingsParse({
      notificationChannelsV1: [
        {
          v: 1,
          id: 'webhook-primary',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/happier',
          signingSecret: null,
          topics: {
            ready: false,
            permissionRequest: false,
            userActionRequest: false,
            connectedServiceAccountSwitch: true,
            connectedServiceQuotaBlocked: false,
            connectedServiceQuotaRecovered: false,
          },
          readyIncludeMessageText: false,
        },
      ],
    });
    const event = {
      topic: 'connected_service_account_switch' as const,
      sessionId: 'session-7',
      serviceId: 'openai-codex',
      groupId: 'dedupe-main',
      fromProfileId: 'primary',
      toProfileId: 'backup',
      reason: 'usage_limit',
    };

    await dispatchActivityNotificationAsync({
      settings,
      event,
      nowMs: () => 1_000,
      dedupeWindowMs: 60_000,
    });
    await dispatchActivityNotificationAsync({
      settings,
      event: {
        ...event,
        fromProfileId: 'backup',
        toProfileId: 'primary',
        reason: 'soft_threshold',
      },
      nowMs: () => 1_500,
      dedupeWindowMs: 60_000,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not dedupe account switch notifications until a channel is deliverable', async () => {
    const disabledSettings = accountSettingsParse({
      notificationChannelsV1: [
        {
          v: 1,
          id: 'webhook-primary',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/happier',
          signingSecret: null,
          topics: {
            ready: false,
            permissionRequest: false,
            userActionRequest: false,
            connectedServiceAccountSwitch: false,
            connectedServiceQuotaBlocked: false,
            connectedServiceQuotaRecovered: false,
          },
          readyIncludeMessageText: false,
        },
      ],
    });
    const enabledSettings = accountSettingsParse({
      notificationChannelsV1: [
        {
          v: 1,
          id: 'webhook-primary',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/happier',
          signingSecret: null,
          topics: {
            ready: false,
            permissionRequest: false,
            userActionRequest: false,
            connectedServiceAccountSwitch: true,
            connectedServiceQuotaBlocked: false,
            connectedServiceQuotaRecovered: false,
          },
          readyIncludeMessageText: false,
        },
      ],
    });
    const event = {
      topic: 'connected_service_account_switch' as const,
      sessionId: 'session-8',
      serviceId: 'openai-codex',
      groupId: 'dedupe-after-eligibility',
      fromProfileId: 'primary',
      toProfileId: 'backup',
      reason: 'usage_limit',
    };

    await dispatchActivityNotificationAsync({
      settings: disabledSettings,
      event,
      nowMs: () => 1_000,
      dedupeWindowMs: 60_000,
    });
    await dispatchActivityNotificationAsync({
      settings: enabledSettings,
      event,
      nowMs: () => 1_500,
      dedupeWindowMs: 60_000,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('delivers sessionless automatic reset webhooks only on enabled recovered channels (%s)', async (enabled) => {
    const settings = accountSettingsParse({ notificationChannelsV1: [{
      v: 1, id: 'reset-webhook', kind: 'webhook', enabled: true,
      url: 'https://hooks.example.test/reset', signingSecret: null,
      topics: { ready: false, permissionRequest: false, userActionRequest: false, connectedServiceQuotaRecovered: enabled },
      readyIncludeMessageText: false,
    }] });
    await dispatchActivityNotificationAsync({ settings, event: {
      topic: 'connected_service_quota_recovered', serviceId: 'openai-codex', groupId: 'team', profileId: 'work',
      recoveryReason: 'automatic_quota_reset', issueFingerprint: 'sessionless-reset',
    }, dedupeWindowMs: 0 });
    expect(fetchSpy).toHaveBeenCalledTimes(enabled ? 1 : 0);
    if (enabled) {
      const body = JSON.parse(fetchSpy.mock.calls[0]?.[1].body as string);
      expect(body).not.toHaveProperty('session');
      expect(body.content.body).toContain('work in pool team');
    }
  });

  it('reports duplicate suppression separately from undeliverable channels', async () => {
    const settings = accountSettingsParse({
      notificationChannelsV1: [
        {
          v: 1,
          id: 'webhook-primary',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/happier',
          signingSecret: null,
          topics: {
            ready: false,
            permissionRequest: false,
            userActionRequest: false,
            connectedServiceAccountSwitch: true,
            connectedServiceQuotaBlocked: false,
            connectedServiceQuotaRecovered: false,
          },
          readyIncludeMessageText: false,
        },
      ],
    });
    const event = {
      topic: 'connected_service_account_switch' as const,
      sessionId: 'session-duplicate-report',
      serviceId: 'openai-codex',
      groupId: 'dedupe-report',
      fromProfileId: 'primary',
      toProfileId: 'backup',
      reason: 'usage_limit',
    };

    const delivered = await dispatchActivityNotificationAsync({
      settings,
      event,
      nowMs: () => 1_000,
      dedupeWindowMs: 60_000,
    });
    const suppressed = await dispatchActivityNotificationAsync({
      settings,
      event,
      nowMs: () => 1_500,
      dedupeWindowMs: 60_000,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(delivered).toMatchObject({
      attemptedChannels: 1,
      deliveredChannels: 1,
      suppressedChannels: 0,
    });
    expect(suppressed).toMatchObject({
      attemptedChannels: 0,
      deliveredChannels: 0,
      suppressedChannels: 1,
    });
  });

  it('allows a duplicate notification after the dedupe ttl expires', async () => {
    const settings = accountSettingsParse({
      notificationChannelsV1: [
        {
          v: 1,
          id: 'webhook-primary',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/happier',
          signingSecret: null,
          topics: {
            ready: false,
            permissionRequest: false,
            userActionRequest: false,
            connectedServiceAccountSwitch: true,
            connectedServiceQuotaBlocked: false,
            connectedServiceQuotaRecovered: false,
          },
          readyIncludeMessageText: false,
        },
      ],
    });
    const event = {
      topic: 'connected_service_account_switch' as const,
      sessionId: 'session-duplicate-ttl',
      serviceId: 'openai-codex',
      groupId: 'dedupe-ttl',
      fromProfileId: 'primary',
      toProfileId: 'backup',
      reason: 'usage_limit',
    };

    await dispatchActivityNotificationAsync({
      settings,
      event,
      nowMs: () => 1_000,
      dedupeWindowMs: 60_000,
    });
    const suppressed = await dispatchActivityNotificationAsync({
      settings,
      event,
      nowMs: () => 1_500,
      dedupeWindowMs: 60_000,
    });
    const deliveredAfterTtl = await dispatchActivityNotificationAsync({
      settings,
      event,
      nowMs: () => 61_000,
      dedupeWindowMs: 60_000,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(suppressed.suppressedChannels).toBe(1);
    expect(deliveredAfterTtl).toMatchObject({
      attemptedChannels: 1,
      deliveredChannels: 1,
      suppressedChannels: 0,
    });
  });

  it('prunes old dedupe entries when the configured max entry count is exceeded', async () => {
    const settings = accountSettingsParse({
      notificationChannelsV1: [
        {
          v: 1,
          id: 'webhook-primary',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/happier',
          signingSecret: null,
          topics: {
            ready: false,
            permissionRequest: false,
            userActionRequest: false,
            connectedServiceAccountSwitch: true,
            connectedServiceQuotaBlocked: false,
            connectedServiceQuotaRecovered: false,
          },
          readyIncludeMessageText: false,
        },
      ],
    });
    const baseEvent = {
      topic: 'connected_service_account_switch' as const,
      sessionId: 'session-duplicate-lru',
      serviceId: 'openai-codex',
      groupId: 'dedupe-lru',
      fromProfileId: 'primary',
      toProfileId: 'backup',
      reason: 'usage_limit',
    };

    await dispatchActivityNotificationAsync({
      settings,
      event: baseEvent,
      nowMs: () => 1_000,
      dedupeWindowMs: 60_000,
      dedupeMaxEntries: 1,
    });
    await dispatchActivityNotificationAsync({
      settings,
      event: { ...baseEvent, groupId: 'dedupe-lru-second' },
      nowMs: () => 1_500,
      dedupeWindowMs: 60_000,
      dedupeMaxEntries: 1,
    });
    const deliveredAfterPrune = await dispatchActivityNotificationAsync({
      settings,
      event: baseEvent,
      nowMs: () => 2_000,
      dedupeWindowMs: 60_000,
      dedupeMaxEntries: 1,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(deliveredAfterPrune).toMatchObject({
      attemptedChannels: 1,
      deliveredChannels: 1,
      suppressedChannels: 0,
    });
  });

  it('uses provider display names for connected-service quota notifications', async () => {
    const settings = accountSettingsParse({
      notificationChannelsV1: [
        {
          v: 1,
          id: 'webhook-primary',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/happier',
          signingSecret: null,
          topics: {
            ready: false,
            permissionRequest: false,
            userActionRequest: false,
            connectedServiceAccountSwitch: false,
            connectedServiceQuotaBlocked: true,
            connectedServiceQuotaRecovered: true,
          },
          readyIncludeMessageText: false,
        },
      ],
    });

    await dispatchActivityNotificationAsync({
      settings,
      event: {
        topic: 'connected_service_quota_blocked',
        sessionId: 'session-quota',
        sessionTitle: 'Continue work',
        serviceId: 'openai-codex',
        serviceDisplayName: 'OpenAI',
        issueFingerprint: 'openai:quota:weekly',
      },
      nowMs: () => 1_000,
    });

    const [, init] = fetchSpy.mock.calls[0] ?? [];
    const payload = JSON.parse(String(init.body));
    expect(payload.content.title).toBe('Continue work');
    expect(payload.content.body).toContain('OpenAI');
    expect(payload.content.body).not.toContain('openai-codex');
    expect(payload.metadata).toMatchObject({
      topic: 'connected_service_quota_blocked',
      serviceDisplayName: 'OpenAI',
    });
  });
});
