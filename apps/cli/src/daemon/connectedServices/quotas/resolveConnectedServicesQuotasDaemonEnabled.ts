import { resolveCliFeatureDecisionForServer } from '@/features/featureDecisionService';

export async function resolveConnectedServicesQuotasDaemonEnabled(params: {
  env: NodeJS.ProcessEnv;
  serverUrl: string;
  timeoutMs?: number;
  featureId?: 'connectedServices.quotas' | 'connectedServices.subscription';
}): Promise<boolean> {
  const resolved = await resolveCliFeatureDecisionForServer({
    featureId: params.featureId ?? 'connectedServices.quotas',
    env: params.env,
    serverUrl: params.serverUrl,
    timeoutMs: params.timeoutMs,
  });

  return resolved.decision.state === 'enabled';
}
