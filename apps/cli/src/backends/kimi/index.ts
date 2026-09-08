import { AGENTS_CORE, normalizeKimiAcpPythonSelector } from '@happier-dev/agents';

import { checklists } from './cli/checklists';
import { resolveProviderSpawnExtrasForRuntime } from '@/settings/providerSettings';
import type { AgentCatalogEntry } from '../types';

export const agent = {
  id: AGENTS_CORE.kimi.id,
  cliSubcommand: AGENTS_CORE.kimi.cliSubcommand,
  getCliCommandHandler: async () => (await import('@/backends/kimi/cli/command')).handleKimiCliCommand,
  getCliCapabilityOverride: async () => (await import('@/backends/kimi/cli/capability')).cliCapability,
  getCliDetect: async () => (await import('@/backends/kimi/cli/detect')).cliDetect,
  getCliAuthSpec: async () => (await import('@/backends/kimi/cli/auth/kimiCliAuthSpec')).kimiCliAuthSpec,
  vendorResumeSupport: AGENTS_CORE.kimi.resume.vendorResume,
  getAcpBackendFactory: async () => {
    const { createKimiBackend } = await import('@/backends/kimi/acp/backend');
    return (opts) => ({ backend: createKimiBackend(opts as any) });
  },
  needsAccountSettingsForProbes: true,
  resolveModelsProbeVariant: ({ accountSettings, processEnv }) => {
    const selector =
      normalizeKimiAcpPythonSelector(processEnv?.HAPPIER_KIMI_ACP_SELECTOR)
      ?? normalizeKimiAcpPythonSelector(accountSettings?.kimiAcpPythonSelector)
      ?? 'auto';
    return `kimi:python-selector:${selector}`;
  },
  resolveModelsProbeBackendOptions: ({ accountSettings, processEnv }) => {
    const extras = resolveProviderSpawnExtrasForRuntime({
      agentId: 'kimi',
      settings: accountSettings ?? {},
      processEnv: processEnv ?? process.env,
    });
    return extras.kimiAcpPythonSelector === 'auto' || extras.kimiAcpPythonSelector === 'poll'
      ? { kimiAcpPythonSelector: extras.kimiAcpPythonSelector }
      : {};
  },
  checklists,
} satisfies AgentCatalogEntry;
