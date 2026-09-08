import { describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';

const { probeModesRawMock, probeConfigOptionsRawMock } = vi.hoisted(() => ({
  probeModesRawMock: vi.fn(async (params: { profileId?: string | null }) => [
    { id: 'default', name: params.profileId ?? 'missing-profile' },
  ]),
  probeConfigOptionsRawMock: vi.fn(async (params: { profileId?: string | null }) => [
    { id: 'profile', name: 'Profile', type: 'text', currentValue: params.profileId ?? 'missing-profile' },
  ]),
}));

vi.mock('@/backends/catalog', () => ({
  AGENTS: {
    codex: {
      getPreflightSessionControlsProbeAdapter: async () => ({
        probeModesRaw: probeModesRawMock,
        probeConfigOptionsRaw: probeConfigOptionsRawMock,
      }),
    },
  },
}));

import { probeAgentConfigOptionsBestEffort } from './agentConfigOptionsProbe';
import { probeAgentModesBestEffort } from './agentModesProbe';

const credentials: Credentials = {
  token: 'profile-probe-token',
  encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
};

describe('preflight session controls profile context', () => {
  it('forwards profile credentials and environment to mode probes and partitions their cache by profile', async () => {
    const shared = {
      agentId: 'codex' as const,
      cwd: '/profile-mode-probe',
      accountSettings: { profiles: [] },
      credentials,
      processEnv: { HAPPIER_FAKE_PROFILE_MARKER: 'profile-env' },
    };

    const first = await probeAgentModesBestEffort({ ...shared, profileId: 'profile-a' });
    const second = await probeAgentModesBestEffort({ ...shared, profileId: 'profile-b' });

    expect(first.availableModes).toEqual([{ id: 'default', name: 'profile-a' }]);
    expect(second.availableModes).toEqual([{ id: 'default', name: 'profile-b' }]);
    expect(probeModesRawMock).toHaveBeenCalledTimes(2);
    expect(probeModesRawMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      profileId: 'profile-a',
      credentials,
      processEnv: shared.processEnv,
    }));
  });

  it('forwards profile credentials and environment to config-option probes and partitions their cache by profile', async () => {
    const shared = {
      agentId: 'codex' as const,
      cwd: '/profile-config-probe',
      accountSettings: { profiles: [] },
      credentials,
      processEnv: { HAPPIER_FAKE_PROFILE_MARKER: 'profile-env' },
    };

    const first = await probeAgentConfigOptionsBestEffort({ ...shared, profileId: 'profile-a' });
    const second = await probeAgentConfigOptionsBestEffort({ ...shared, profileId: 'profile-b' });

    expect(first.configOptions[0]?.currentValue).toBe('profile-a');
    expect(second.configOptions[0]?.currentValue).toBe('profile-b');
    expect(probeConfigOptionsRawMock).toHaveBeenCalledTimes(2);
    expect(probeConfigOptionsRawMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      profileId: 'profile-a',
      credentials,
      processEnv: shared.processEnv,
    }));
  });
});
