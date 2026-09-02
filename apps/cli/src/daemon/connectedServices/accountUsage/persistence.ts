import {
  ConnectedServiceUsageSourceV1Schema,
  ProviderAccountUsageRecordIdSchema,
  ProviderAccountUsageSnapshotV1Schema,
  sealProviderAccountUsageSnapshotCiphertext,
  type ConnectedServiceUsageSourceV1,
  type ProviderAccountUsageRecordId,
  type ProviderAccountUsageSnapshotV1,
  type SealedProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { createKeyedBackoffTracker } from '@/api/connection/scheduling/createKeyedBackoffTracker';

import {
  createConnectedServiceQuotaPersistenceScheduler,
  type ConnectedServiceQuotaPersistenceCircuit,
} from '../quotas/createConnectedServiceQuotaPersistenceScheduler';
import {
  computeProviderAccountUsageSnapshotFingerprint,
  deriveProviderAccountUsageFingerprintKey,
  type ProviderAccountUsageFingerprintKey,
} from './fingerprint';

const DEFAULT_PROVIDER_ACCOUNT_USAGE_PERSISTENCE_MIN_FRESHNESS_MS = 60_000;

export type ProviderAccountUsagePersistenceStatus = 'ok' | 'unavailable' | 'estimated' | 'error';

export type ProviderAccountUsagePersistenceMetadata = Readonly<{
  fetchedAt: number;
  staleAfterMs: number;
  status: ProviderAccountUsagePersistenceStatus;
  materialFingerprint?: string;
}>;

export type ProviderAccountUsageApi = Readonly<{
  getAccountEncryptionMode: () => Promise<'plain' | 'e2ee' | 'unknown'>;
  registerProviderAccountUsageSnapshotPlain?: (args: Readonly<{
    recordId: ProviderAccountUsageRecordId;
    source?: ConnectedServiceUsageSourceV1;
    content: { t: 'plain'; v: ProviderAccountUsageSnapshotV1 };
    metadata: ProviderAccountUsagePersistenceMetadata;
  }>) => Promise<void>;
  registerProviderAccountUsageSnapshotSealed?: (args: Readonly<{
    recordId: ProviderAccountUsageRecordId;
    recordKey: ProviderAccountUsageSnapshotV1['recordKey'];
    source?: ConnectedServiceUsageSourceV1;
    sealed: SealedProviderAccountUsageSnapshotV1;
    metadata: ProviderAccountUsagePersistenceMetadata;
  }>) => Promise<void>;
}>;

type ProviderAccountUsagePersistenceMaterialState = Readonly<{
  fingerprint: string;
  fetchedAt: number;
  status: ProviderAccountUsagePersistenceStatus;
}>;

type ProviderAccountUsagePersistencePayload = Readonly<{
  recordId: ProviderAccountUsageRecordId;
  snapshot: ProviderAccountUsageSnapshotV1;
  source?: ConnectedServiceUsageSourceV1;
  status: ProviderAccountUsagePersistenceStatus;
  materialFingerprint: string;
  materialState: ProviderAccountUsagePersistenceMaterialState;
}>;

export type ProviderAccountUsagePersistenceScheduler = Readonly<{
  recordInBandSnapshot(
    snapshot: ProviderAccountUsageSnapshotV1,
    options?: Readonly<{ source?: ConnectedServiceUsageSourceV1; sources?: readonly ConnectedServiceUsageSourceV1[] }>,
  ): Promise<
    | Readonly<{ status: 'enqueued'; enqueue: 'accepted' | 'coalesced' }>
    | Readonly<{ status: 'already_persisted'; reason: string }>
  >;
  flush(timeoutMs: number): Promise<unknown>;
  getCircuitSnapshot(): ReadonlyArray<ConnectedServiceQuotaPersistenceCircuit<string>>;
  dispose(): void;
}>;

function normalizeNonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export function buildProviderAccountUsageSnapshotRoute(params: Readonly<{
  version: 'v2' | 'v3';
  recordId: string;
}>): string {
  const recordId = ProviderAccountUsageRecordIdSchema.parse(params.recordId);
  return `/${params.version}/connect/provider-account-usage/${encodeURIComponent(recordId)}`;
}

function deriveProviderAccountUsageStatus(snapshot: ProviderAccountUsageSnapshotV1): ProviderAccountUsagePersistenceStatus {
  if (snapshot.state === 'error_last_known_good') return 'error';
  if (snapshot.meters.length === 0) return 'ok';
  const statuses = snapshot.meters.map((meter) => meter.status);
  if (statuses.every((status) => status === 'unavailable')) return 'unavailable';
  if (statuses.some((status) => status === 'estimated')) return 'estimated';
  return 'ok';
}

function sourcePersistenceKey(source: ConnectedServiceUsageSourceV1 | undefined): string {
  if (!source) return 'record';
  if (source.bindingKind === 'group_member') {
    return JSON.stringify([
      'group_member',
      source.serviceId,
      source.profileId,
      source.groupId ?? '',
      source.groupGeneration ?? null,
    ]);
  }
  return JSON.stringify(['profile', source.serviceId, source.profileId]);
}

function normalizePersistenceSources(
  options: Readonly<{ source?: ConnectedServiceUsageSourceV1; sources?: readonly ConnectedServiceUsageSourceV1[] }> | undefined,
): readonly (ConnectedServiceUsageSourceV1 | undefined)[] {
  const sources = [
    ...(options?.source ? [options.source] : []),
    ...(options?.sources ?? []),
  ];
  if (sources.length === 0) return [undefined];

  const byKey = new Map<string, ConnectedServiceUsageSourceV1>();
  for (const source of sources) {
    const parsed = ConnectedServiceUsageSourceV1Schema.parse(source);
    byKey.set(sourcePersistenceKey(parsed), parsed);
  }
  return [...byKey.values()];
}

function shouldPersistProviderAccountUsageSnapshot(input: Readonly<{
  previous: ProviderAccountUsagePersistenceMaterialState | null;
  next: ProviderAccountUsagePersistenceMaterialState;
  minFreshnessMs: number;
}>): Readonly<{ persist: boolean; reason: string }> {
  if (!input.previous) return { persist: true, reason: 'first_snapshot' };
  if (input.next.fetchedAt < input.previous.fetchedAt) return { persist: false, reason: 'stale' };
  if (input.next.status !== input.previous.status) return { persist: true, reason: 'status' };
  if (input.next.fingerprint !== input.previous.fingerprint) return { persist: true, reason: 'fingerprint' };
  if (input.next.fetchedAt - input.previous.fetchedAt >= input.minFreshnessMs) {
    return { persist: true, reason: 'freshness' };
  }
  return { persist: false, reason: 'unchanged' };
}

function resolveFingerprintKey(params: Readonly<{
  fingerprintKey?: ProviderAccountUsageFingerprintKey;
  credentials?: Credentials;
  serverScope?: string;
  accountScope?: string;
}>): ProviderAccountUsageFingerprintKey {
  if (params.fingerprintKey) return params.fingerprintKey;
  if (!params.credentials) {
    throw new Error('Provider account usage persistence requires credentials or a fingerprint key');
  }
  return deriveProviderAccountUsageFingerprintKey({
    credentials: params.credentials,
    serverScope: params.serverScope ?? 'active-server',
    accountScope: params.accountScope ?? 'active-account',
  });
}

export function createProviderAccountUsagePersistenceScheduler(params: Readonly<{
  api: ProviderAccountUsageApi;
  now: () => number;
  fingerprintKey?: ProviderAccountUsageFingerprintKey;
  credentials?: Credentials;
  randomBytes?: (length: number) => Uint8Array;
  serverScope?: string;
  accountScope?: string;
  minFreshnessMs?: number;
}>): ProviderAccountUsagePersistenceScheduler {
  const fingerprintKey = resolveFingerprintKey(params);
  const minFreshnessMs = normalizeNonNegativeInteger(
    params.minFreshnessMs ?? DEFAULT_PROVIDER_ACCOUNT_USAGE_PERSISTENCE_MIN_FRESHNESS_MS,
  );
  const stateByPersistenceKey = new Map<string, ProviderAccountUsagePersistenceMaterialState>();
  const backoff = createKeyedBackoffTracker({
    baseDelayMs: 1_000,
    maxDelayMs: 60_000,
    jitterRatio: 0,
    now: params.now,
  });

  async function persistPayload(_key: string, payload: ProviderAccountUsagePersistencePayload): Promise<void> {
    const accountMode = await params.api.getAccountEncryptionMode();
    const metadata: ProviderAccountUsagePersistenceMetadata = {
      fetchedAt: payload.snapshot.fetchedAtMs,
      staleAfterMs: payload.snapshot.staleAfterMs,
      status: payload.status,
      materialFingerprint: payload.materialFingerprint,
    };

    if (accountMode === 'plain' && params.api.registerProviderAccountUsageSnapshotPlain) {
      await params.api.registerProviderAccountUsageSnapshotPlain({
        recordId: payload.recordId,
        ...(payload.source ? { source: payload.source } : {}),
        content: { t: 'plain', v: payload.snapshot },
        metadata,
      });
      stateByPersistenceKey.set(_key, payload.materialState);
      return;
    }

    if (accountMode !== 'e2ee' || !params.api.registerProviderAccountUsageSnapshotSealed) {
      throw new Error('Provider account usage persistence route unavailable for account mode');
    }
    if (!params.credentials || !params.randomBytes) {
      throw new Error('Provider account usage sealed persistence requires credentials and randomBytes');
    }

    const material = params.credentials.encryption.type === 'legacy'
      ? { type: 'legacy' as const, secret: params.credentials.encryption.secret }
      : { type: 'dataKey' as const, machineKey: params.credentials.encryption.machineKey };
    const ciphertext = sealProviderAccountUsageSnapshotCiphertext({
      material,
      payload: payload.snapshot,
      randomBytes: params.randomBytes,
    });
    await params.api.registerProviderAccountUsageSnapshotSealed({
      recordId: payload.recordId,
      recordKey: payload.snapshot.recordKey,
      ...(payload.source ? { source: payload.source } : {}),
      sealed: { format: 'account_scoped_v1', ciphertext },
      metadata,
    });
    stateByPersistenceKey.set(_key, payload.materialState);
  }

  const scheduler = createConnectedServiceQuotaPersistenceScheduler<string, ProviderAccountUsagePersistencePayload>({
    run: persistPayload,
    maxConcurrent: 2,
    minKeyIntervalMs: 0,
    maxKeys: 500,
    maxKeyAgeMs: 60 * 60_000,
    maxPendingPayloadAgeMs: 10 * 60_000,
    now: params.now,
    backoff,
  });

  return {
    recordInBandSnapshot: async (inputSnapshot, options) => {
      const snapshot = ProviderAccountUsageSnapshotV1Schema.parse(inputSnapshot);
      const status = deriveProviderAccountUsageStatus(snapshot);
      const materialFingerprint = computeProviderAccountUsageSnapshotFingerprint(snapshot, fingerprintKey);
      const materialState: ProviderAccountUsagePersistenceMaterialState = {
        fingerprint: materialFingerprint,
        fetchedAt: snapshot.fetchedAtMs,
        status,
      };
      let accepted = false;
      let coalesced = false;
      let lastSuppressionReason = 'unchanged';
      for (const source of normalizePersistenceSources(options)) {
        const persistenceKey = `${snapshot.recordId}\u0000${sourcePersistenceKey(source)}`;
        const decision = shouldPersistProviderAccountUsageSnapshot({
          previous: stateByPersistenceKey.get(persistenceKey) ?? null,
          next: materialState,
          minFreshnessMs,
        });
        if (!decision.persist) {
          lastSuppressionReason = decision.reason;
          continue;
        }

        const enqueue = scheduler.enqueue(persistenceKey, {
          recordId: snapshot.recordId,
          snapshot,
          ...(source ? { source } : {}),
          status,
          materialFingerprint,
          materialState,
        });
        if (enqueue.type === 'accepted') accepted = true;
        if (enqueue.type === 'coalesced') coalesced = true;
        if (enqueue.type === 'suppressed') {
          throw new Error(`provider_account_usage_persistence_${enqueue.reason}`);
        }
      }
      if (accepted || coalesced) {
        return { status: 'enqueued', enqueue: accepted ? 'accepted' : 'coalesced' };
      }
      return { status: 'already_persisted', reason: lastSuppressionReason };
    },
    flush: async (timeoutMs) => await scheduler.flushAll(timeoutMs),
    getCircuitSnapshot: () => scheduler.getCircuitSnapshot(),
    dispose: () => scheduler.dispose(),
  };
}
