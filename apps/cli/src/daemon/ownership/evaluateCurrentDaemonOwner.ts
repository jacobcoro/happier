import { readFileSync } from 'node:fs';

import { getReleaseRingCatalogEntry } from '@happier-dev/release-runtime/releaseRings';

import { configuration } from '@/configuration';
import {
  inspectDaemonRunningStateAndCleanupStaleState,
  type DaemonRunningInspection,
} from '@/daemon/controlClient';
import { resolveComparableCliVersion } from '@/daemon/resolveComparableCliVersion';
import { findAllHappyProcesses, type HappyProcessInfo } from '@/daemon/doctor';
import {
  resolveDaemonStartupSourceServiceManagedState,
  type DaemonStartupSource,
} from '@/daemon/ownership/daemonOwnershipMetadata';
import { projectPath } from '@/projectPath';

import type { DaemonLocallyPersistedState } from '@/persistence';

export type CurrentDaemonOwner = Readonly<{
  status: Extract<DaemonRunningInspection['status'], 'starting' | 'running'>;
  source: 'state' | 'process';
  state: DaemonLocallyPersistedState;
  currentCliVersion: string;
  currentPublicReleaseChannel: 'stable' | 'preview' | 'dev';
  versionMatches: boolean;
  releaseChannelMatches: boolean;
  serviceManaged: boolean | null;
  startupSource: DaemonStartupSource | 'unknown';
  /** Additional long-lived controllers that claim this exact server-profile lifecycle scope. */
  otherControllerPids?: readonly number[];
}>;

export type DaemonOwnerEvaluation =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'compatible'; owner: CurrentDaemonOwner }>
  | Readonly<{ kind: 'conflict'; owner: CurrentDaemonOwner }>;

function resolveCurrentCliVersion(): string {
  return resolveComparableCliVersion({
    fallbackVersion: configuration.currentCliVersion,
    projectRootPath: projectPath(),
    readFileSyncImpl: readFileSync,
  });
}

function normalizePathFragment(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}

function normalizeScopeValue(value: string | null | undefined): string {
  return String(value ?? '').trim();
}

function normalizeServerUrl(value: string | null | undefined): string {
  return normalizeScopeValue(value).replace(/\/+$/, '').toLowerCase();
}

function processEnvValueMatchesCurrent(
  processValue: string | null | undefined,
  currentValue: string | null | undefined,
  normalize: (value: string) => string = normalizeScopeValue,
): boolean {
  const processScopeValue = normalizeScopeValue(processValue);
  if (!processScopeValue) return true;
  const currentScopeValue = normalizeScopeValue(currentValue);
  if (!currentScopeValue) return true;
  return normalize(processScopeValue) === normalize(currentScopeValue);
}

function daemonProcessMatchesCurrentScope(processInfo: HappyProcessInfo): boolean {
  const env = processInfo.daemonOwnershipEnvironmentVariables;
  if (!env) return true;

  if (!processEnvValueMatchesCurrent(env.HAPPIER_HOME_DIR, configuration.happyHomeDir, normalizePathFragment)) {
    return false;
  }
  const processLifecycleScopeId = normalizeScopeValue(env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID);
  const currentLifecycleScopeId = normalizeScopeValue(process.env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID);
  if (processLifecycleScopeId) {
    if (!currentLifecycleScopeId || processLifecycleScopeId !== currentLifecycleScopeId) return false;
    // Explicit lifecycle scope is the canonical owner identity. Endpoint profile and URL are
    // independently mutable connection facts and cannot disqualify that exact owner.
    return true;
  }

  // Released stack daemons predate the explicit lifecycle-scope variable and used their
  // already-resolved active server id as the stable lifecycle id. Only that old-daemon shape
  // may fall back to ACTIVE_SERVER_ID and endpoint URL comparison.
  const currentFallbackScope = currentLifecycleScopeId || configuration.activeServerId;
  if (!processEnvValueMatchesCurrent(env.HAPPIER_ACTIVE_SERVER_ID, currentFallbackScope)) {
    return false;
  }

  const processServerUrl = normalizeServerUrl(env.HAPPIER_SERVER_URL);
  if (processServerUrl) {
    const currentServerUrls = new Set([
      normalizeServerUrl(configuration.serverUrl),
      normalizeServerUrl(configuration.apiServerUrl),
      normalizeServerUrl(configuration.publicServerUrl),
    ].filter(Boolean));
    if (currentServerUrls.size > 0 && !currentServerUrls.has(processServerUrl)) {
      return false;
    }
  }

  return true;
}

export function isDaemonProcessForCurrentRuntimeRoot(processInfo: HappyProcessInfo, currentRuntimeRoot: string): boolean {
  if (processInfo.pid === process.pid) return false;
  if (processInfo.type !== 'daemon' && processInfo.type !== 'dev-daemon') return false;

  const command = normalizePathFragment(processInfo.command);
  if (!command.includes(currentRuntimeRoot)) return false;

  // The process classifier labels both the transient `daemon start` launcher and the actual
  // `daemon start-sync` daemon as `daemon`/`dev-daemon`. Only `start-sync` is a real, long-lived
  // daemon owner. The launcher is a bootstrapper that spawns the detached daemon and then blocks
  // waiting for the relay, so counting it here makes managed startup conflict with its own
  // launcher — producing the all-"unknown" stateless-owner conflict that prevents the daemon from
  // ever coming up.
  return command.includes('daemon start-sync');
}

async function findDaemonProcessesForCurrentRuntimeRoot(): Promise<HappyProcessInfo[]> {
  if (process.env.NODE_ENV === 'test' && process.env.HAPPIER_DAEMON_PROCESS_INVENTORY_FALLBACK !== '1') {
    return [];
  }

  const currentRuntimeRoot = normalizePathFragment(projectPath());
  const matching = (await findAllHappyProcesses())
    .filter((processInfo) => isDaemonProcessForCurrentRuntimeRoot(processInfo, currentRuntimeRoot))
    .filter((processInfo) => daemonProcessMatchesCurrentScope(processInfo))
    .sort((a, b) => a.pid - b.pid);
  return matching;
}

export async function evaluateCurrentDaemonOwner(): Promise<DaemonOwnerEvaluation> {
  const inspection = await inspectDaemonRunningStateAndCleanupStaleState();
  const currentCliVersion = resolveCurrentCliVersion();
  const currentPublicReleaseChannel = getReleaseRingCatalogEntry(configuration.publicReleaseRing).publicLabel;

  if (inspection.status === 'not-running') {
    const processOnlyOwners = await findDaemonProcessesForCurrentRuntimeRoot();
    const processOnlyOwner = processOnlyOwners[0] ?? null;
    if (processOnlyOwner) {
      const owner: CurrentDaemonOwner = {
        status: 'running',
        source: 'process',
        state: {
          pid: processOnlyOwner.pid,
          httpPort: 0,
          startedAt: Date.now(),
          startedWithCliVersion: 'unknown',
        },
        currentCliVersion,
        currentPublicReleaseChannel,
        versionMatches: false,
        releaseChannelMatches: false,
        serviceManaged: null,
        startupSource: 'unknown',
        ...(processOnlyOwners.length > 1
          ? { otherControllerPids: processOnlyOwners.slice(1).map((processInfo) => processInfo.pid) }
          : {}),
      };
      return { kind: 'conflict', owner };
    }
    return { kind: 'none' };
  }

  if (!('state' in inspection)) {
    const owner: CurrentDaemonOwner = {
      status: inspection.status,
      source: 'process',
      state: {
        pid: inspection.pid,
        httpPort: 0,
        startedAt: Date.now(),
        startedWithCliVersion: 'unknown',
      },
      currentCliVersion,
      currentPublicReleaseChannel,
      versionMatches: false,
      releaseChannelMatches: false,
      serviceManaged: null,
      startupSource: 'unknown',
    };
    return { kind: 'conflict', owner };
  }

  const state = inspection.state;
  const versionMatches = state.startedWithCliVersion === currentCliVersion;
  const releaseChannelMatches = Boolean(
    state.startedWithPublicReleaseChannel
    && state.startedWithPublicReleaseChannel === currentPublicReleaseChannel,
  );
  const hasLegacyMissingReleaseChannel = !state.startedWithPublicReleaseChannel;
  const startupSource = state.startupSource ?? 'unknown';
  const otherControllerPids = (await findDaemonProcessesForCurrentRuntimeRoot())
    .map((processInfo) => processInfo.pid)
    .filter((pid) => pid !== state.pid);
  const owner: CurrentDaemonOwner = {
    status: inspection.status,
    source: 'state',
    state,
    currentCliVersion,
    currentPublicReleaseChannel,
    versionMatches,
    releaseChannelMatches,
    serviceManaged: resolveDaemonStartupSourceServiceManagedState(state.startupSource, state.serviceLabel),
    startupSource,
    ...(otherControllerPids.length > 0 ? { otherControllerPids } : {}),
  };

  if (otherControllerPids.length > 0) return { kind: 'conflict', owner };
  return versionMatches && (releaseChannelMatches || hasLegacyMissingReleaseChannel)
    ? { kind: 'compatible', owner }
    : { kind: 'conflict', owner };
}
