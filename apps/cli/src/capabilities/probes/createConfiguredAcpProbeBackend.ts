import type { BackendTargetRefV1 } from '@happier-dev/protocol';

import type { AgentBackend } from '@/agent/core';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { createConfiguredAcpBackend } from '@/agent/acp/catalog/configured/createConfiguredAcpBackend';
import { materializeConfiguredAcpEnvironment } from '@/agent/acp/catalog/configured/materializeConfiguredAcpEnvironment';
import { resolveConfiguredAcpBackendFromAccountSettings } from '@/agent/acp/catalog/configured/resolveConfiguredAcpBackendFromAccountSettings';
import type { CatalogAgentId } from '@/backends/types';
import type { Credentials } from '@/persistence';

export async function createConfiguredAcpProbeBackend(params: Readonly<{
  agentId: CatalogAgentId;
  backendTarget?: BackendTargetRefV1;
  cwd: string;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  credentials?: Credentials | null;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<AgentBackend | null> {
  if (params.agentId !== 'customAcp') return null;
  if (params.backendTarget?.kind !== 'configuredAcpBackend') return null;
  if (!params.accountSettings || !params.credentials) return null;

  const backend = resolveConfiguredAcpBackendFromAccountSettings(
    params.accountSettings,
    params.backendTarget.backendId,
  );
  if (!backend) return null;

  const selectedEnvironmentOverlay = Object.fromEntries(
    Object.entries(params.processEnv ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && process.env[entry[0]] !== entry[1],
    ),
  );
  const launchEnv = {
    ...selectedEnvironmentOverlay,
    ...materializeConfiguredAcpEnvironment({
      backend,
      accountSettings: params.accountSettings,
      credentials: params.credentials,
      processEnv: params.processEnv,
    }),
  };

  const permissionHandler: AcpPermissionHandler = {
    handleToolCall: async () => ({ decision: 'abort' }),
  };

  return createConfiguredAcpBackend({
    cwd: params.cwd,
    backend,
    launchEnv,
    mcpServers: {},
    permissionHandler,
  });
}
