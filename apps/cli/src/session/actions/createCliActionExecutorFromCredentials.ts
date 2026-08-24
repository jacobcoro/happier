import type { Credentials } from '@/persistence';
import type { DirectSpawnedSessionTransport } from '@/session/services/createSpawnedSession';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { resolveSessionEncryptionContextFromCredentials } from '@/session/transport/encryption/sessionEncryptionContext';
import type { SessionSpawnCustody } from '@/session/services/createSpawnedSession';
import { readCurrentHappierSessionIdFromEnv } from '@/agent/runtime/session/currentSessionIdEnv';

import { createCliActionExecutor } from './createCliActionExecutor';

export function createCliActionExecutorFromCredentials(params: Readonly<{
  credentials: Credentials;
  directSpawnTransport?: DirectSpawnedSessionTransport;
  overrides?: Partial<ActionExecutorDeps>;
  onSpawnCustodyChange?: (custody: SessionSpawnCustody) => void;
  processEnv?: NodeJS.ProcessEnv;
}>): ReturnType<typeof createCliActionExecutor> {
  const ctx = resolveSessionEncryptionContextFromCredentials(params.credentials);
  const callerSessionId = readCurrentHappierSessionIdFromEnv(params.processEnv ?? process.env);

  return createCliActionExecutor({
    token: params.credentials.token,
    credentials: params.credentials,
    sessionId: callerSessionId ?? 'cli-global',
    ctx,
    ...(params.directSpawnTransport ? { directSpawnTransport: params.directSpawnTransport } : {}),
    ...(params.onSpawnCustodyChange ? { onSpawnCustodyChange: params.onSpawnCustodyChange } : {}),
  }, params.overrides);
}
