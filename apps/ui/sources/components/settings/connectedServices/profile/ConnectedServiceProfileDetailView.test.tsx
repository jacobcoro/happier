import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { connectedServicesModuleState, installConnectedServicesCommonModuleMocks } from '../connectedServicesTestHelpers';
import type { UseConnectedServiceQuotaSnapshotResult } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSnapshot';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW_MS = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const applySettingsSpy = vi.fn(async () => {});
const modalSpies = vi.hoisted(() => ({
  confirm: vi.fn(),
  prompt: vi.fn(),
  alert: vi.fn(),
}));
const textSpies = vi.hoisted(() => ({
  translate: vi.fn((key: string, _params?: Record<string, unknown>) => key),
}));
const routeParams = { serviceId: 'openai-codex', profileId: 'work' };
const profileState = vi.hoisted(() => ({
  current: {
    connectedServicesV2: [
      {
        serviceId: 'openai-codex',
        profiles: [{ profileId: 'work', status: 'connected', kind: 'oauth', providerEmail: 'me@example.com', providerAccountId: 'acct-1' }],
        groups: [] as Array<Record<string, unknown>>,
      },
    ],
    connectedServiceCredentialRevisionsV1: [{
      serviceId: 'openai-codex',
      profileId: 'work',
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    }],
  } as Record<string, unknown>,
}));
const settingsState = vi.hoisted(() => ({
  current: {
    connectedServicesDefaultProfileByServiceId: { 'openai-codex': 'work' } as Record<string, string>,
    connectedServicesProfileLabelByKey: {} as Record<string, string>,
    connectedServicesQuotaPinnedMeterIdsByKey: {} as Record<string, ReadonlyArray<string>>,
    connectedServicesQuotaSummaryStrategyByKey: {},
    connectedServicesCollapsedItemKeysV1: {} as Record<string, boolean>,
  } as Record<string, unknown>,
}));
const featureState = vi.hoisted(() => ({
  connectedServices: true,
  quotas: true,
  subscription: true,
  accountGroups: true,
}));

async function flushAsyncHandlers() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

installConnectedServicesCommonModuleMocks({
  searchParams: routeParams,
  modal: async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
      spies: {
        confirm: modalSpies.confirm,
        prompt: modalSpies.prompt,
        alert: modalSpies.alert,
      },
    }).module;
  },
  text: async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: textSpies.translate });
  },
});

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
  const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
  return createExpoVectorIconsMock();
});

vi.mock('react-native-svg', () => ({
  SvgXml: (props: Record<string, unknown>) => React.createElement('SvgXml', props),
  Svg: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
    React.createElement('Svg', props, props.children),
  Circle: (props: Record<string, unknown>) => React.createElement('Circle', props, null),
}));

const reducedMotionRef = vi.hoisted(() => ({ value: true }));
vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
  useReducedMotionPreference: () => reducedMotionRef.value,
}));

const stableCredentials = { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } as const;
vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: stableCredentials }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: (featureId: string) => {
    if (featureId === 'connectedServices') return featureState.connectedServices;
    if (featureId === 'connectedServices.quotas') return featureState.quotas;
    if (featureId === 'connectedServices.subscription') return featureState.subscription;
    if (featureId === 'connectedServices.accountGroups') return featureState.accountGroups;
    return true;
  },
}));

// The quota snapshot hook is a server/data-loading boundary; AccountBlock and the
// Connection section both consume it (deduped by the shared store at runtime).
const quotaHookState = vi.hoisted(() => ({
  refresh: vi.fn(async () => {}),
  callSpy: vi.fn(),
  value: null as unknown,
}));
const connectedServiceCredentialSpies = vi.hoisted(() => ({
  storeConnectedServiceCredentialForAccount: vi.fn(async () => {}),
  deleteConnectedServiceCredentialForAccount: vi.fn(async () => {}),
}));
vi.mock('@/hooks/server/connectedServices/useConnectedServiceQuotaSnapshot', () => ({
  useConnectedServiceQuotaSnapshot: (params: unknown) => {
    quotaHookState.callSpy(params);
    return quotaHookState.value;
  },
}));

vi.mock('@/sync/store/hooks', async () => {
  const actual = await vi.importActual<typeof import('@/sync/store/hooks')>('@/sync/store/hooks');
  const ReactModule = await import('react');
  return {
    ...actual,
    useProfile: () => profileState.current,
    useSettings: () => settingsState.current,
    useSettingMutable: (key: string) => {
      const initial = (settingsState.current as Record<string, unknown>)[key] ?? {};
      const [value, setValue] = ReactModule.useState(() => initial);
      return [value, setValue];
    },
  };
});

vi.mock('@/sync/sync', () => ({
  sync: { refreshProfile: vi.fn(async () => {}), applySettings: vi.fn(async () => {}) },
}));

vi.mock('@/sync/store/settingsWriters', () => ({
  useApplySettings: () => applySettingsSpy,
}));

vi.mock('@/sync/domains/connectedServices/storeConnectedServiceCredentialForAccount', () => ({
  storeConnectedServiceCredentialForAccount: connectedServiceCredentialSpies.storeConnectedServiceCredentialForAccount,
  deleteConnectedServiceCredentialForAccount: connectedServiceCredentialSpies.deleteConnectedServiceCredentialForAccount,
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => {
  const ReactModule = require('react');
  return {
    ItemRowActions: (props: Record<string, unknown>) => ReactModule.createElement('ItemRowActions', props),
  };
});

function buildQuotaResult(overrides: Partial<UseConnectedServiceQuotaSnapshotResult> = {}): UseConnectedServiceQuotaSnapshotResult {
  return {
    snapshot: {
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: NOW_MS - 1000,
      staleAfterMs: 60_000,
      planLabel: 'Pro',
      accountLabel: null,
      recoveryCredits: null,
      meters: [],
    } as unknown as UseConnectedServiceQuotaSnapshotResult['snapshot'],
    loading: false,
    error: null,
    isStale: false,
    nowMs: NOW_MS,
    recoveryCreditSummary: null,
    recoveryCreditMachineId: 'machine-1',
    canConsumeRecoveryCredit: true,
    canRefresh: true,
    isRefreshing: false,
    refresh: quotaHookState.refresh,
    consumeRecoveryCredit: vi.fn(async () => {}),
    consumeRecoveryCreditPending: false,
    consumeRecoveryCreditPendingTarget: null,
    pinnedMeterIds: [],
    togglePinnedMeter: vi.fn(),
    ...overrides,
  };
}

function findByTestId(tree: renderer.ReactTestRenderer, testID: string) {
  return tree.root.findAll((node) => node.props?.testID === testID)[0] ?? null;
}

beforeEach(() => {
  routeParams.serviceId = 'openai-codex';
  routeParams.profileId = 'work';
  applySettingsSpy.mockClear();
  connectedServicesModuleState.routerPushSpy.mockClear();
  modalSpies.confirm.mockReset();
  modalSpies.prompt.mockReset();
  modalSpies.alert.mockReset();
  textSpies.translate.mockClear();
  quotaHookState.refresh.mockClear();
  quotaHookState.callSpy.mockClear();
  quotaHookState.value = buildQuotaResult();
  connectedServiceCredentialSpies.storeConnectedServiceCredentialForAccount.mockClear();
  connectedServiceCredentialSpies.deleteConnectedServiceCredentialForAccount.mockClear();
  reducedMotionRef.value = true;
  featureState.connectedServices = true;
  featureState.quotas = true;
  featureState.subscription = true;
  featureState.accountGroups = true;
  profileState.current = {
    connectedServicesV2: [
      {
        serviceId: 'openai-codex',
        profiles: [{ profileId: 'work', status: 'connected', kind: 'oauth', providerEmail: 'me@example.com', providerAccountId: 'acct-1' }],
        groups: [],
      },
    ],
    connectedServiceCredentialRevisionsV1: [{
      serviceId: 'openai-codex',
      profileId: 'work',
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    }],
  };
  settingsState.current = {
    connectedServicesDefaultProfileByServiceId: { 'openai-codex': 'work' },
    connectedServicesProfileLabelByKey: {},
    connectedServicesQuotaPinnedMeterIdsByKey: {},
    connectedServicesQuotaSummaryStrategyByKey: {},
    connectedServicesCollapsedItemKeysV1: {},
  };
});

describe('ConnectedServiceProfileDetailView', () => {
  it('renders the shared AccountBlock for the connected identity + quota composition', async () => {
    const { ConnectedServiceProfileDetailView } = await import('./ConnectedServiceProfileDetailView');
    const screen = await renderScreen(<ConnectedServiceProfileDetailView />);

    expect(findByTestId(screen.tree, 'connected-service-profile-account')).toBeTruthy();
    // The shared quota hook is mounted for the connected account.
    expect(quotaHookState.callSpy).toHaveBeenCalled();
  });

  it('renders the shared AccountBlock for retryable refresh-failure profiles', async () => {
    profileState.current = {
      connectedServicesV2: [
        {
          serviceId: 'openai-codex',
          profiles: [{
            profileId: 'work',
            status: 'refresh_failed_retryable',
            kind: 'oauth',
            providerEmail: 'me@example.com',
            providerAccountId: 'acct-1',
          }],
          groups: [],
        },
      ],
    };
    const { ConnectedServiceProfileDetailView } = await import('./ConnectedServiceProfileDetailView');
    const screen = await renderScreen(<ConnectedServiceProfileDetailView />);

    expect(findByTestId(screen.tree, 'connected-service-profile-account')).toBeTruthy();
    expect(findByTestId(screen.tree, 'connected-services-profile-action:reconnect')).toBeFalsy();
    expect(quotaHookState.callSpy).toHaveBeenCalled();
  });

  it('keeps the stable profile id visible when a custom label masks the profile identity', async () => {
    routeParams.profileId = 'leeroy';
    profileState.current = {
      connectedServicesV2: [
        {
          serviceId: 'openai-codex',
          profiles: [{
            profileId: 'leeroy',
            status: 'connected',
            kind: 'oauth',
            providerEmail: 'leeroy.brun@gmail.com',
            providerAccountId: 'acct-1',
          }],
          groups: [],
        },
      ],
    };
    settingsState.current = {
      ...settingsState.current,
      connectedServicesDefaultProfileByServiceId: { 'openai-codex': 'leeroy' },
      connectedServicesProfileLabelByKey: { 'openai-codex/leeroy': 'batiplus' },
    };

    const { ConnectedServiceProfileDetailView } = await import('./ConnectedServiceProfileDetailView');
    const screen = await renderScreen(<ConnectedServiceProfileDetailView />);

    expect(screen.getTextContent()).toContain('batiplus');
    expect(screen.getTextContent()).toContain('leeroy.brun@gmail.com');
    expect(screen.getTextContent()).toContain('leeroy');
  });

  it('does not repeat an unlabeled token profile id in the account subtitle', async () => {
    featureState.quotas = false;
    featureState.subscription = false;
    routeParams.profileId = 'native-token';
    profileState.current = {
      connectedServicesV2: [
        {
          serviceId: 'openai-codex',
          profiles: [{
            profileId: 'native-token',
            status: 'connected',
            kind: 'token',
            providerEmail: null,
            providerAccountId: null,
          }],
          groups: [],
        },
      ],
    };
    settingsState.current = {
      ...settingsState.current,
      connectedServicesDefaultProfileByServiceId: { 'openai-codex': 'native-token' },
      connectedServicesProfileLabelByKey: {},
    };

    const { ConnectedServiceProfileDetailView } = await import('./ConnectedServiceProfileDetailView');
    const screen = await renderScreen(<ConnectedServiceProfileDetailView />);
    const header = findByTestId(screen.tree, 'connected-service-profile-account:header');

    expect(header?.props.accessibilityLabel).toBe('native-token');
    expect(header?.props.subtitle).toBeUndefined();
  });

  it('offers reconnect for a healthy OAuth profile', async () => {
    const { ConnectedServiceProfileDetailView } = await import('./ConnectedServiceProfileDetailView');
    const screen = await renderScreen(<ConnectedServiceProfileDetailView />);

    const actionHost = screen.tree.root.findAll((node) => (node.type as unknown) === 'ItemRowActions')[0];
    const actions = (actionHost?.props?.actions ?? []) as ReadonlyArray<{ id: string }>;
    expect(actions.some((action) => action.id === 'reconnect')).toBe(true);
  });

  it('renders the Settings, Connection, and Remove sections with stable testIDs', async () => {
    const { ConnectedServiceProfileDetailView } = await import('./ConnectedServiceProfileDetailView');
    const screen = await renderScreen(<ConnectedServiceProfileDetailView />);

    expect(findByTestId(screen.tree, 'connected-service-profile-action:set-default')).toBeTruthy();
    expect(findByTestId(screen.tree, 'connected-service-profile-action:edit-label')).toBeTruthy();
    expect(findByTestId(screen.tree, 'connected-service-profile-account:refresh')).toBeTruthy();
    expect(findByTestId(screen.tree, 'connected-service-profile:refresh-quota')).toBeNull();
    expect(findByTestId(screen.tree, 'connected-service-profile-action:disconnect')).toBeTruthy();
  });

  it('toggles the default profile via the Set-as-default switch', async () => {
    settingsState.current = {
      ...settingsState.current,
      connectedServicesDefaultProfileByServiceId: {},
    };
    const { ConnectedServiceProfileDetailView } = await import('./ConnectedServiceProfileDetailView');
    const screen = await renderScreen(<ConnectedServiceProfileDetailView />);

    await act(async () => {
      findByTestId(screen.tree, 'connected-service-profile:default-switch')?.props.onValueChange?.(true);
      await flushAsyncHandlers();
    });

    expect(applySettingsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        connectedServicesDefaultProfileByServiceId: { 'openai-codex': 'work' },
      }),
    );
  });

  it('refreshes the quota snapshot through the shared hook', async () => {
    const { ConnectedServiceProfileDetailView } = await import('./ConnectedServiceProfileDetailView');
    const screen = await renderScreen(<ConnectedServiceProfileDetailView />);

    await act(async () => {
      findByTestId(screen.tree, 'connected-service-profile-account:refresh')?.props.onPress?.();
      await flushAsyncHandlers();
    });

    expect(quotaHookState.refresh).toHaveBeenCalledTimes(1);
  });

  it('prompts to edit the profile label and persists it', async () => {
    modalSpies.prompt.mockResolvedValueOnce('Work laptop');
    const { ConnectedServiceProfileDetailView } = await import('./ConnectedServiceProfileDetailView');
    const screen = await renderScreen(<ConnectedServiceProfileDetailView />);

    await act(async () => {
      findByTestId(screen.tree, 'connected-service-profile-action:edit-label')?.props.onPress?.();
      await flushAsyncHandlers();
    });

    expect(modalSpies.prompt).toHaveBeenCalled();
    expect(applySettingsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        connectedServicesProfileLabelByKey: { 'openai-codex/work': 'Work laptop' },
      }),
    );
  });

  it('passes the resolved profile label to destructive disconnect confirmation text', async () => {
    settingsState.current = {
      ...settingsState.current,
      connectedServicesProfileLabelByKey: { 'openai-codex/work': 'Work laptop' },
    };
    modalSpies.confirm.mockResolvedValueOnce(false);
    const { ConnectedServiceProfileDetailView } = await import('./ConnectedServiceProfileDetailView');
    const screen = await renderScreen(<ConnectedServiceProfileDetailView />);

    await act(async () => {
      findByTestId(screen.tree, 'connected-service-profile-action:disconnect')?.props.onPress?.();
      await flushAsyncHandlers();
    });

    const disconnectBodyCall = textSpies.translate.mock.calls.find(([key]) =>
      key === 'connectedServices.detail.disconnectConfirmBody');
    const params = disconnectBodyCall?.[1] as { profileId?: unknown } | undefined;
    const profileLabel = String(params?.profileId ?? '');
    expect(profileLabel).toContain('Work laptop');
    expect(profileLabel).toContain('work');
    expect(profileLabel).not.toBe('work');
    expect(modalSpies.confirm).toHaveBeenCalledWith(
      'modals.disconnect',
      'connectedServices.detail.disconnectConfirmBody',
      expect.objectContaining({
        confirmText: 'modals.disconnect',
        cancelText: 'common.cancel',
      }),
    );
  });

  it('prunes stale profile preferences after disconnecting a connected profile', async () => {
    settingsState.current = {
      ...settingsState.current,
      connectedServicesDefaultProfileByServiceId: {
        'openai-codex': 'work',
        'claude-subscription': 'leeroy',
      },
      connectedServicesProfileLabelByKey: {
        'openai-codex/work': 'Work laptop',
        'openai-codex/backup': 'Backup',
      },
    };
    modalSpies.confirm.mockResolvedValueOnce(true);
    const { ConnectedServiceProfileDetailView } = await import('./ConnectedServiceProfileDetailView');
    const screen = await renderScreen(<ConnectedServiceProfileDetailView />);

    await act(async () => {
      findByTestId(screen.tree, 'connected-service-profile-action:disconnect')?.props.onPress?.();
      await flushAsyncHandlers();
    });

    expect(connectedServiceCredentialSpies.deleteConnectedServiceCredentialForAccount).toHaveBeenCalledWith(
      expect.objectContaining({ token: 't' }),
      {
        serviceId: 'openai-codex',
        profileId: 'work',
        expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      },
    );
    expect(applySettingsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        connectedServicesDefaultProfileByServiceId: { 'claude-subscription': 'leeroy' },
        connectedServicesProfileLabelByKey: { 'openai-codex/backup': 'Backup' },
      }),
    );
  });

  it('shows the pools memberships section with an empty state and "Add to pool" action', async () => {
    const { ConnectedServiceProfileDetailView } = await import('./ConnectedServiceProfileDetailView');
    const screen = await renderScreen(<ConnectedServiceProfileDetailView />);

    expect(findByTestId(screen.tree, 'connected-service-profile-pools:empty')).toBeTruthy();
    expect(findByTestId(screen.tree, 'connected-service-profile-action:add-to-pool')).toBeTruthy();
  });

  it('routes "Add to pool" to the provider Pools segment with the profile carried through', async () => {
    const { ConnectedServiceProfileDetailView } = await import('./ConnectedServiceProfileDetailView');
    const screen = await renderScreen(<ConnectedServiceProfileDetailView />);

    await act(async () => {
      findByTestId(screen.tree, 'connected-service-profile-action:add-to-pool')?.props.onPress?.();
      await flushAsyncHandlers();
    });

    expect(connectedServicesModuleState.routerPushSpy).toHaveBeenCalledWith({
      pathname: '/settings/connected-services/[serviceId]',
      params: { serviceId: 'openai-codex', segment: 'pools', profileId: 'work' },
    });
  });

  it('lists pool memberships derived from the projected groups', async () => {
    profileState.current = {
      connectedServicesV2: [
        {
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'work', status: 'connected', kind: 'oauth', providerEmail: 'me@example.com', providerAccountId: 'acct-1' }],
          groups: [{ groupId: 'g1', displayName: 'Team Pool', memberProfileIds: ['work'] }],
        },
      ],
    };
    const { ConnectedServiceProfileDetailView } = await import('./ConnectedServiceProfileDetailView');
    const screen = await renderScreen(<ConnectedServiceProfileDetailView />);

    const poolRow = findByTestId(screen.tree, 'connected-service-profile-pool:0');
    expect(poolRow).toBeTruthy();
    expect(poolRow?.props.title).toBe('Team Pool');
    expect(findByTestId(screen.tree, 'connected-service-profile-pools:empty')).toBeFalsy();
  });

  it('hides the pools section when the accountGroups feature is disabled (fail-closed)', async () => {
    featureState.accountGroups = false;
    const { ConnectedServiceProfileDetailView } = await import('./ConnectedServiceProfileDetailView');
    const screen = await renderScreen(<ConnectedServiceProfileDetailView />);

    expect(findByTestId(screen.tree, 'connected-service-profile-action:add-to-pool')).toBeFalsy();
  });

  it('needs-re-auth variant hides USAGE/RESETS (no AccountBlock) and shows reconnect', async () => {
    profileState.current = {
      connectedServicesV2: [
        {
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'work', status: 'needs_reauth', kind: 'oauth', providerEmail: 'me@example.com', providerAccountId: 'acct-1' }],
          groups: [],
        },
      ],
    };
    const { ConnectedServiceProfileDetailView } = await import('./ConnectedServiceProfileDetailView');
    const screen = await renderScreen(<ConnectedServiceProfileDetailView />);

    // No quota composition for a re-auth account: the shared hook is never mounted.
    expect(quotaHookState.callSpy).not.toHaveBeenCalled();
    expect(findByTestId(screen.tree, 'connected-service-profile-account')).toBeFalsy();
    expect(findByTestId(screen.tree, 'connected-services-profile-action:reconnect')).toBeTruthy();
  });

  it('renders the connected-services-disabled state when the feature is off', async () => {
    featureState.connectedServices = false;
    const { ConnectedServiceProfileDetailView } = await import('./ConnectedServiceProfileDetailView');
    const { t } = await import('@/text');
    const screen = await renderScreen(<ConnectedServiceProfileDetailView />);

    expect(screen.tree.root.findAll((n) => n.props?.title === t('settings.connectedAccounts'))).not.toHaveLength(0);
    expect(findByTestId(screen.tree, 'connected-service-profile-account')).toBeFalsy();
  });

  it('renders an unknown-profile guard state for nonexistent profile ids', async () => {
    routeParams.profileId = 'missing';
    const { ConnectedServiceProfileDetailView } = await import('./ConnectedServiceProfileDetailView');
    const { t } = await import('@/text');
    const screen = await renderScreen(<ConnectedServiceProfileDetailView />);

    expect(screen.tree.root.findAll((n) => n.props?.title === t('connectedServices.detail.alerts.unknownProfileTitle'))).toHaveLength(1);
    expect(findByTestId(screen.tree, 'connected-service-profile-action:disconnect')).toBeFalsy();
    expect(applySettingsSpy).not.toHaveBeenCalled();
  });
});
