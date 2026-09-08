import type { AgentBackend } from '@/agent/core/AgentBackend';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { AgentPromptPayload } from '@/agent/core/AgentPromptPayload';
import type { AgentId } from '@happier-dev/agents';
import type { AcpConfigOptionOverridesV1, BackendTargetRefV1 } from '@happier-dev/protocol';

import { sendAgentPromptPayload, sendAgentSteerPromptPayload } from '@/agent/core/AgentPromptPayload';
import { createConfiguredAcpBackend } from '@/agent/acp/catalog/configured/createConfiguredAcpBackend';
import { materializeConfiguredAcpEnvironment } from '@/agent/acp/catalog/configured/materializeConfiguredAcpEnvironment';
import { resolveConfiguredAcpBackendFromAccountSettings } from '@/agent/acp/catalog/configured/resolveConfiguredAcpBackendFromAccountSettings';
import { createExecutionRunPermissionHandler } from '@/agent/executionRuns/policy/executionRunPermissionDecision';
import { getExecutionRunBackendDescriptor } from '@/agent/executionRuns/registry/executionRunBackendRegistry';
import { resolveCustomHappierToolsContext } from '@/agent/tools/happierTools/customMcp/resolveCustomHappierToolsContext';
import { resolveBackendIsolationBundle } from '@/runtime/isolation/resolveBackendIsolationBundle';
import { readCredentials, readSettings } from '@/persistence';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { assertBackendEnabledByAccountSettings } from '@/settings/backendEnabled';
import { createRunScopedExecutionPermissionHandler } from './runScopedExecutionPermissionHandler';

export { createRunScopedExecutionPermissionHandler } from './runScopedExecutionPermissionHandler';

export { createExecutionRunPermissionHandler } from '@/agent/executionRuns/policy/executionRunPermissionDecision';

function startBestEffortConstructionCleanup(cleanup: (() => void | Promise<void>) | null): void {
  if (!cleanup) return;
  try {
    void Promise.resolve(cleanup()).catch(() => {});
  } catch {
    // Construction must preserve its original error even when cleanup itself throws synchronously.
  }
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeAccountSettings(value: unknown): Readonly<Record<string, unknown>> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Readonly<Record<string, unknown>>;
}

function resolveExecutionRunAccountSettings(params: Readonly<{
  backendTarget?: BackendTargetRefV1;
  accountSettings?: unknown;
}>): Readonly<Record<string, unknown>> | null {
  const explicitSettings = normalizeAccountSettings(params.accountSettings);
  if (explicitSettings) return explicitSettings;
  if (params.backendTarget?.kind === 'configuredAcpBackend') {
    return null;
  }
  return normalizeAccountSettings(getActiveAccountSettingsSnapshot()?.settings ?? null);
}

function createLazyConfiguredAcpExecutionRunBackend(opts: Readonly<{
  cwd: string;
  backendTarget: BackendTargetRefV1;
  modelId?: string;
  permissionMode: string;
  runId?: string;
  credentials?: Awaited<ReturnType<typeof readCredentials>> | null;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  interactivePermissionHandler?: AcpPermissionHandler;
}>): AgentBackend {
  const configuredBackendId = opts.backendTarget.kind === 'configuredAcpBackend'
    ? opts.backendTarget.backendId
    : '';
  const runId = normalizeNonEmptyString(opts.runId);
  const runPermissionScope = opts.interactivePermissionHandler && runId
    ? createRunScopedExecutionPermissionHandler({ runId, handler: opts.interactivePermissionHandler })
    : null;
  const permissionHandler = createExecutionRunPermissionHandler({
    backendId: configuredBackendId || 'customAcp',
    permissionMode: opts.permissionMode,
    interactiveHandler: runPermissionScope?.handler,
  });
  const handlers = new Set<Parameters<AgentBackend['onMessage']>[0]>();
  const registeredHandlers = new Set<Parameters<AgentBackend['onMessage']>[0]>();
  let resolvedBackendPromise: Promise<AgentBackend> | null = null;
  const selectedModelId = normalizeNonEmptyString(opts.modelId);
  let resolvedSessionModelId: string | undefined;

  const resolveBackend = async (): Promise<AgentBackend> => {
    if (resolvedBackendPromise) return await resolvedBackendPromise;
    resolvedBackendPromise = (async () => {
      if (opts.backendTarget.kind !== 'configuredAcpBackend') {
        throw new Error(`Unsupported execution-run backend: customAcp`);
      }
      const credentials = opts.credentials ?? await readCredentials();
      if (!credentials) {
        throw new Error('Missing credentials for configured ACP execution run');
      }
      const settings = opts.accountSettings ?? (await bootstrapAccountSettingsContext({
        credentials,
        backendTarget: opts.backendTarget,
      })).settings;
      const backendDefinition = resolveConfiguredAcpBackendFromAccountSettings(settings, opts.backendTarget.backendId);
      if (!backendDefinition) {
        throw new Error(`Unknown configured ACP backend: ${opts.backendTarget.backendId}`);
      }
      resolvedSessionModelId = selectedModelId ?? normalizeNonEmptyString(backendDefinition.defaultModel);

      const launchEnv = materializeConfiguredAcpEnvironment({
        backend: backendDefinition,
        accountSettings: settings,
        credentials,
      });
      const machineId = normalizeNonEmptyString((await readSettings()).machineId);
      const resolvedMcpServers = machineId
        ? (await resolveCustomHappierToolsContext({
            credentials,
            accountSettings: settings,
            machineId,
            directory: opts.cwd,
          })).mcpServers
        : {};
      const backend = createConfiguredAcpBackend({
        cwd: opts.cwd,
        backend: backendDefinition,
        launchEnv,
        mcpServers: resolvedMcpServers,
        permissionHandler,
      });
      for (const handler of handlers) {
        if (!registeredHandlers.has(handler)) {
          backend.onMessage(handler);
          registeredHandlers.add(handler);
        }
      }
      return backend;
    })();
    return await resolvedBackendPromise;
  };

  const applySelectedModelId = async (backend: AgentBackend, sessionId: string): Promise<void> => {
    const configurableBackend = backend as AgentBackend & {
      setSessionModel?: (sessionId: string, modelId: string) => Promise<void>;
    };
    if (!resolvedSessionModelId || typeof configurableBackend.setSessionModel !== 'function') return;
    await configurableBackend.setSessionModel(sessionId, resolvedSessionModelId);
  };

  return {
    async startSession(initialPrompt) {
      const backend = await resolveBackend();
      const started = await backend.startSession(initialPrompt);
      await applySelectedModelId(backend, started.sessionId);
      return started;
    },
    async sendPrompt(sessionId, prompt) {
      const backend = await resolveBackend();
      await backend.sendPrompt(sessionId, prompt);
    },
    async sendPromptPayload(sessionId: string, payload: AgentPromptPayload) {
      const backend = await resolveBackend();
      await sendAgentPromptPayload(backend, sessionId, payload);
    },
    async sendSteerPrompt(sessionId, prompt) {
      const backend = await resolveBackend();
      if (typeof backend.sendSteerPrompt !== 'function') {
        throw new Error('Backend does not support steering');
      }
      await backend.sendSteerPrompt(sessionId, prompt);
    },
    async sendSteerPromptPayload(sessionId: string, payload: AgentPromptPayload) {
      const backend = await resolveBackend();
      await sendAgentSteerPromptPayload(backend, sessionId, payload);
    },
    async cancel(sessionId) {
      const backend = await resolveBackend();
      await backend.cancel(sessionId);
    },
    onMessage(handler) {
      handlers.add(handler);
      void resolvedBackendPromise?.then((backend) => {
        if (!registeredHandlers.has(handler)) {
          backend.onMessage(handler);
          registeredHandlers.add(handler);
        }
      }).catch(() => {});
    },
    offMessage(handler) {
      handlers.delete(handler);
      registeredHandlers.delete(handler);
      void resolvedBackendPromise?.then((backend) => {
        backend.offMessage?.(handler);
      }).catch(() => {});
    },
    async respondToPermission(requestId, approved) {
      const backend = await resolveBackend();
      if (typeof backend.respondToPermission !== 'function') return;
      await backend.respondToPermission(requestId, approved);
    },
    async waitForResponseComplete(timeoutMs) {
      const backend = await resolveBackend();
      if (typeof backend.waitForResponseComplete !== 'function') return;
      await backend.waitForResponseComplete(timeoutMs);
    },
    async dispose() {
      runPermissionScope?.dispose('Execution run disposed');
      const backend = await resolvedBackendPromise?.catch(() => null);
      if (!backend) return;
      await backend.dispose();
    },
  };
}

export function createExecutionRunBackend(opts: Readonly<{
  cwd: string;
  runId?: string;
  backendId: string;
  backendTarget?: BackendTargetRefV1;
  modelId?: string;
  /**
   * Optional canonical config-option overrides for the run (e.g. `reasoning_effort`), SAME shape as
   * session spawn. Threaded to the backend factory so providers apply run options exactly like a
   * spawned session. Absent keeps the backend's configured defaults.
   */
  sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
  permissionMode: string;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  start?: Readonly<{ intentInput?: unknown; retentionPolicy?: string; intent?: string }> | null;
  /**
   * Provider-agnostic connected-service environment for this run, already materialized by the daemon
   * run-materialization bridge (e.g. `CODEX_HOME`/`CLAUDE_CONFIG_DIR`). Merged into the isolation
   * bundle BEFORE the per-backend `resolveIsolation` so runs use CS accounts/pools exactly like
   * sessions. No provider knowledge lives here — the keys come from the daemon materializer.
   */
  connectedServicesEnv?: Readonly<Record<string, string>> | null;
  /**
   * Idempotent run-end release for the daemon-side CS registration + run-scoped materialized root.
   * Invoked on backend dispose (run end / stop) regardless of retention policy — the materialized
   * root is run-scoped, so a later resume re-materializes rather than reusing a stale root.
   */
  connectedServicesCleanup?: (() => Promise<void>) | null;
  interactivePermissionHandler?: AcpPermissionHandler;
}>): AgentBackend {
  const connectedServicesCleanup = opts.connectedServicesCleanup ?? null;
  let acquiredIsolationCleanup: (() => void | Promise<void>) | null = null;
  try {
    const backendId = String(opts.backendId ?? '').trim();
    const accountSettings = resolveExecutionRunAccountSettings({
      backendTarget: opts.backendTarget,
      accountSettings: opts.accountSettings,
    });
    if (accountSettings && opts.backendTarget?.kind === 'builtInAgent') {
      assertBackendEnabledByAccountSettings({
        agentId: opts.backendTarget.agentId as AgentId,
        backendTarget: opts.backendTarget,
        settings: accountSettings,
      });
    }
    if (accountSettings && opts.backendTarget?.kind === 'configuredAcpBackend') {
      assertBackendEnabledByAccountSettings({
        backendTarget: opts.backendTarget,
        settings: accountSettings,
      });
    }
    if (backendId === 'customAcp' && opts.backendTarget?.kind === 'configuredAcpBackend') {
      const runId = normalizeNonEmptyString(opts.runId);
      return createLazyConfiguredAcpExecutionRunBackend({
        cwd: opts.cwd,
        backendTarget: opts.backendTarget,
        modelId: opts.modelId,
        permissionMode: opts.permissionMode,
        ...(runId ? { runId } : {}),
        credentials: null,
        accountSettings,
        interactivePermissionHandler: opts.interactivePermissionHandler,
      });
    }
    const runId = normalizeNonEmptyString(opts.runId);
    const runPermissionScope = opts.interactivePermissionHandler && runId
      ? createRunScopedExecutionPermissionHandler({ runId, handler: opts.interactivePermissionHandler })
      : null;
    const permissionHandler = createExecutionRunPermissionHandler({
      backendId,
      permissionMode: opts.permissionMode,
      interactiveHandler: runPermissionScope?.handler,
    });
    const descriptor = getExecutionRunBackendDescriptor(backendId);
    if (!descriptor) {
      throw new Error(`Unsupported execution-run backend: ${backendId}`);
    }

    const connectedServicesEnv = opts.connectedServicesEnv && typeof opts.connectedServicesEnv === 'object'
      ? opts.connectedServicesEnv
      : null;
    const hasConnectedServicesEnv = connectedServicesEnv !== null && Object.keys(connectedServicesEnv).length > 0;

    const retentionPolicy = String(opts.start?.retentionPolicy ?? '').trim();
    const shouldCleanupIsolation = retentionPolicy === 'ephemeral';
    const shouldIsolate = shouldCleanupIsolation
      || String(opts.runId ?? '').trim().length > 0
      || hasConnectedServicesEnv;
    const intent = (() => {
      const raw = String(opts.start?.intent ?? '').trim();
      return raw.length > 0 ? raw : undefined;
    })();

    const isolationId = shouldIsolate ? (String(opts.runId ?? '').trim() || `run_${backendId}_${Date.now()}`) : '';
    const resolvedBaseBundle = shouldIsolate
      ? resolveBackendIsolationBundle({
          backendId,
          isolationId,
          scope: 'execution_run',
          ...(intent ? { intent } : {}),
          cwd: opts.cwd,
        })
      : null;
    if (shouldCleanupIsolation) {
      acquiredIsolationCleanup = resolvedBaseBundle?.cleanup ?? null;
    }

    // Generic, pre-descriptor CS env merge (design pin: the isolation-bundle choke point). Provider env
    // keys (e.g. `CODEX_HOME`) come from the daemon materializer and take precedence over the base
    // isolation env so the run reads the materialized CS home instead of the runner's inherited account.
    const baseBundle = resolvedBaseBundle && hasConnectedServicesEnv && connectedServicesEnv
      ? { ...resolvedBaseBundle, env: { ...resolvedBaseBundle.env, ...connectedServicesEnv } }
      : resolvedBaseBundle;

    const bundle = baseBundle && descriptor.resolveIsolation
      ? descriptor.resolveIsolation(
          {
            backendId,
            isolationId,
            scope: 'execution_run',
            ...(intent ? { intent } : {}),
            cwd: opts.cwd,
          },
          baseBundle,
        )
      : baseBundle;
    if (shouldCleanupIsolation) {
      acquiredIsolationCleanup = bundle?.cleanup ?? acquiredIsolationCleanup;
    }

    const shouldCleanupBundleOnDispose = shouldCleanupIsolation && Boolean(bundle?.cleanup);
    const backend = descriptor.factory({
      cwd: opts.cwd,
      backendId,
      modelId: opts.modelId,
      ...(opts.sessionConfigOptionOverrides ? { sessionConfigOptionOverrides: opts.sessionConfigOptionOverrides } : {}),
      permissionMode: opts.permissionMode,
      accountSettings,
      permissionHandler,
      start: opts.start ?? null,
      ...(bundle ? { isolation: { env: bundle.env, settingsPath: bundle.settingsPath } } : {}),
    });

    if (shouldCleanupBundleOnDispose || connectedServicesCleanup || runPermissionScope) {
      const originalDispose = backend.dispose.bind(backend);
      let disposal: Promise<void> | null = null;
      backend.dispose = () => {
        if (!disposal) {
          disposal = (async () => {
            runPermissionScope?.dispose('Execution run disposed');
            try {
              await originalDispose();
            } finally {
              try {
                if (shouldCleanupBundleOnDispose) {
                  await bundle?.cleanup?.();
                }
              } finally {
                // Run-end ER-CS release (idempotent, best-effort inside the callback itself).
                await connectedServicesCleanup?.();
              }
            }
          })();
        }
        return disposal;
      };
    }

    return backend;
  } catch (error) {
    // Connected-service materialization and every synchronous backend-construction stage are one
    // acquisition boundary. Start both best-effort cleanups, but never replace the construction
    // error with a cleanup failure. The connected callback itself owns its shared once-promise.
    startBestEffortConstructionCleanup(acquiredIsolationCleanup);
    startBestEffortConstructionCleanup(connectedServicesCleanup);
    throw error;
  }
}
