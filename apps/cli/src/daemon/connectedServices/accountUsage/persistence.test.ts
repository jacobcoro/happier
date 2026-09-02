import {
  buildProviderAccountUsageRecordId,
  type ConnectedServiceUsageSourceV1,
  type ProviderAccountUsageRecordKeyV1,
  type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';

type AccountUsageApi = Readonly<{
  getAccountEncryptionMode: () => Promise<'plain' | 'e2ee' | 'unknown'>;
  registerProviderAccountUsageSnapshotPlain?: (args: Readonly<{
    recordId: string;
    source?: ConnectedServiceUsageSourceV1;
    content: { t: 'plain'; v: ProviderAccountUsageSnapshotV1 };
    metadata: {
      fetchedAt: number;
      staleAfterMs: number;
      status: 'ok' | 'unavailable' | 'estimated' | 'error';
      materialFingerprint?: string;
    };
  }>) => Promise<void>;
  registerProviderAccountUsageSnapshotSealed?: (args: Readonly<{
    recordId: string;
    source?: ConnectedServiceUsageSourceV1;
    sealed: { format: 'account_scoped_v1'; ciphertext: string };
    metadata: {
      fetchedAt: number;
      staleAfterMs: number;
      status: 'ok' | 'unavailable' | 'estimated' | 'error';
      materialFingerprint?: string;
    };
  }>) => Promise<void>;
}>;

type PersistenceModule = Readonly<{
  buildProviderAccountUsageSnapshotRoute(params: Readonly<{
    version: 'v2' | 'v3';
    recordId: string;
  }>): string;
  createProviderAccountUsagePersistenceScheduler(params: Readonly<{
    api: AccountUsageApi;
    now: () => number;
    fingerprintKey?: Uint8Array;
    credentials?: Credentials;
    randomBytes?: (length: number) => Uint8Array;
    minFreshnessMs?: number;
  }>): Readonly<{
    recordInBandSnapshot(
      snapshot: ProviderAccountUsageSnapshotV1,
      options?: Readonly<{ source?: ConnectedServiceUsageSourceV1; sources?: readonly ConnectedServiceUsageSourceV1[] }>,
    ): Promise<
      | Readonly<{ status: 'enqueued'; enqueue: 'accepted' | 'coalesced' }>
      | Readonly<{ status: 'already_persisted'; reason: string }>
    >;
    flush(timeoutMs: number): Promise<unknown>;
    getCircuitSnapshot(): ReadonlyArray<Readonly<{
      key: string;
      state: 'open';
      consecutiveFailures: number;
      nextProbeAtMs: number | null;
      lastError: Readonly<{ message: string; status?: number; code?: string }>;
    }>>;
    dispose(): void;
  }>;
}>;

async function loadPersistenceModule(): Promise<PersistenceModule | null> {
  return await import('./persistence').catch(() => null) as PersistenceModule | null;
}

function createKey(accountSubjectId = 'acct_123'): ProviderAccountUsageRecordKeyV1 {
  return {
    providerId: 'codex',
    accountSubjectId,
    subjectKind: 'account',
    quotaScope: 'account',
  };
}

function createSnapshot(recordKey = createKey()): ProviderAccountUsageSnapshotV1 {
  return {
    v: 1,
    recordId: buildProviderAccountUsageRecordId(recordKey),
    recordKey,
    providerId: recordKey.providerId,
    accountSubject: { kind: 'providerSubject', id: recordKey.accountSubjectId },
    observedAtMs: 1_000,
    fetchedAtMs: 1_000,
    staleAfterMs: 300_000,
    source: 'runtimeSignal',
    confidence: 'confirmed',
    state: 'loaded_data',
    meters: [],
  };
}

function createCredentials(): Credentials {
  return {
    token: 'happy-token',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(3) },
  };
}

describe('provider account usage persistence', () => {
  it('builds canonical provider-account-usage snapshot routes by record id', async () => {
    const module = await loadPersistenceModule();
    expect(module).not.toBeNull();
    const snapshot = createSnapshot();

    expect(module!.buildProviderAccountUsageSnapshotRoute({
      version: 'v3',
      recordId: snapshot.recordId,
    })).toBe(`/v3/connect/provider-account-usage/${encodeURIComponent(snapshot.recordId)}`);
    expect(module!.buildProviderAccountUsageSnapshotRoute({
      version: 'v2',
      recordId: snapshot.recordId,
    })).toBe(`/v2/connect/provider-account-usage/${encodeURIComponent(snapshot.recordId)}`);
  });

  it('persists plaintext snapshots through the provider-account-usage API interface, not connected-service profile quota keys', async () => {
    const module = await loadPersistenceModule();
    expect(module).not.toBeNull();
    const snapshot = createSnapshot();
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
      registerConnectedServiceQuotaSnapshotPlain: vi.fn(async () => {}),
    };
    const scheduler = module!.createProviderAccountUsagePersistenceScheduler({
      api,
      now: () => 1_000,
      fingerprintKey: new Uint8Array(32).fill(9),
      minFreshnessMs: 0,
    });

    await expect(scheduler.recordInBandSnapshot(snapshot)).resolves.toEqual({
      status: 'enqueued',
      enqueue: 'accepted',
    });
    await scheduler.flush(1_000);
    scheduler.dispose();

    expect(api.registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledWith({
      recordId: snapshot.recordId,
      content: { t: 'plain', v: snapshot },
      metadata: expect.objectContaining({
        fetchedAt: 1_000,
        staleAfterMs: 300_000,
        status: 'ok',
        materialFingerprint: expect.any(String),
      }),
    });
    expect(api.registerProviderAccountUsageSnapshotSealed).not.toHaveBeenCalled();
    expect(api.registerConnectedServiceQuotaSnapshotPlain).not.toHaveBeenCalled();
  });

  it('reports an identical snapshot as already persisted after the first write drains', async () => {
    const module = await loadPersistenceModule();
    expect(module).not.toBeNull();
    const scheduler = module!.createProviderAccountUsagePersistenceScheduler({
      api: {
        getAccountEncryptionMode: async () => 'plain',
        registerProviderAccountUsageSnapshotPlain: async () => {},
      },
      now: () => 1_000,
      fingerprintKey: new Uint8Array(32).fill(9),
      minFreshnessMs: 60_000,
    });
    const snapshot = createSnapshot();
    try {
      await expect(scheduler.recordInBandSnapshot(snapshot)).resolves.toEqual({
        status: 'enqueued',
        enqueue: 'accepted',
      });
      await scheduler.flush(1_000);

      await expect(scheduler.recordInBandSnapshot(snapshot)).resolves.toEqual({
        status: 'already_persisted',
        reason: 'unchanged',
      });
    } finally {
      scheduler.dispose();
    }
  });

  it('rejects intake when the persistence scheduler cannot take custody', async () => {
    const module = await loadPersistenceModule();
    expect(module).not.toBeNull();
    const scheduler = module!.createProviderAccountUsagePersistenceScheduler({
      api: {
        getAccountEncryptionMode: async () => 'plain',
        registerProviderAccountUsageSnapshotPlain: async () => {},
      },
      now: () => 1_000,
      fingerprintKey: new Uint8Array(32).fill(9),
    });
    scheduler.dispose();

    await expect(scheduler.recordInBandSnapshot(createSnapshot()))
      .rejects.toThrow('provider_account_usage_persistence_disposed');
  });

  it('retains intake behind exponential backoff, reports the real 503, and recovers on its bounded probe', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let recovered = false;
    const persistenceError = new Error('503 upstream provider quota write unavailable');
    Object.assign(persistenceError, { status: 503, code: 'upstream_quota_persistence_unavailable' });
    const register = vi.fn(async () => {
      if (!recovered) throw persistenceError;
    });
    const module = await loadPersistenceModule();
    expect(module).not.toBeNull();
    const scheduler = module!.createProviderAccountUsagePersistenceScheduler({
      api: {
        getAccountEncryptionMode: async () => 'plain',
        registerProviderAccountUsageSnapshotPlain: register,
      },
      now: Date.now,
      fingerprintKey: new Uint8Array(32).fill(9),
      minFreshnessMs: 0,
    });
    try {
      await expect(scheduler.recordInBandSnapshot(createSnapshot())).resolves.toEqual({
        status: 'enqueued',
        enqueue: 'accepted',
      });
      await vi.advanceTimersByTimeAsync(15_000);

      expect(register).toHaveBeenCalledTimes(5);
      expect(scheduler.getCircuitSnapshot()).toEqual([
        expect.objectContaining({
          state: 'open',
          consecutiveFailures: 5,
          nextProbeAtMs: 31_000,
          lastError: {
            name: 'Error',
            message: '503 upstream provider quota write unavailable',
            status: 503,
            code: 'upstream_quota_persistence_unavailable',
          },
        }),
      ]);
      await expect(scheduler.recordInBandSnapshot(createSnapshot())).resolves.toEqual({
        status: 'enqueued',
        enqueue: 'coalesced',
      });

      await vi.advanceTimersByTimeAsync(15_999);
      expect(register).toHaveBeenCalledTimes(5);
      recovered = true;
      await vi.advanceTimersByTimeAsync(1);

      expect(register).toHaveBeenCalledTimes(6);
      expect(scheduler.getCircuitSnapshot()).toEqual([]);
    } finally {
      scheduler.dispose();
      vi.useRealTimers();
    }
  });

  it('passes explicit connected-service source context through plaintext provider-account usage persistence', async () => {
    const module = await loadPersistenceModule();
    expect(module).not.toBeNull();
    const snapshot = createSnapshot();
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    };
    const scheduler = module!.createProviderAccountUsagePersistenceScheduler({
      api,
      now: () => 1_000,
      fingerprintKey: new Uint8Array(32).fill(9),
      minFreshnessMs: 0,
    });

    await scheduler.recordInBandSnapshot(snapshot, {
      source: {
        serviceId: 'openai-codex',
        profileId: 'work',
        bindingKind: 'profile',
      },
    });
    await scheduler.flush(1_000);
    scheduler.dispose();

    expect(api.registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledWith(expect.objectContaining({
      recordId: snapshot.recordId,
      source: {
        serviceId: 'openai-codex',
        profileId: 'work',
        bindingKind: 'profile',
      },
    }));
  });

  it('persists every connected-service source relation for a provider-account usage record', async () => {
    const module = await loadPersistenceModule();
    expect(module).not.toBeNull();
    const snapshot = createSnapshot();
    const profileSource: ConnectedServiceUsageSourceV1 = {
      serviceId: 'openai-codex',
      profileId: 'work',
      bindingKind: 'profile',
    };
    const groupSource: ConnectedServiceUsageSourceV1 = {
      serviceId: 'openai-codex',
      profileId: 'work',
      bindingKind: 'group_member',
      groupId: 'team',
      groupGeneration: 4,
    };
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    };
    const scheduler = module!.createProviderAccountUsagePersistenceScheduler({
      api,
      now: () => 1_000,
      fingerprintKey: new Uint8Array(32).fill(9),
      minFreshnessMs: 0,
    });

    await scheduler.recordInBandSnapshot(snapshot, {
      sources: [profileSource, groupSource],
    });
    await scheduler.flush(1_000);
    scheduler.dispose();

    expect(api.registerProviderAccountUsageSnapshotPlain).toHaveBeenCalledTimes(2);
    expect(api.registerProviderAccountUsageSnapshotPlain).toHaveBeenNthCalledWith(1, expect.objectContaining({
      recordId: snapshot.recordId,
      source: profileSource,
    }));
    expect(api.registerProviderAccountUsageSnapshotPlain).toHaveBeenNthCalledWith(2, expect.objectContaining({
      recordId: snapshot.recordId,
      source: groupSource,
    }));
  });

  it('seals e2ee snapshots through the provider-account-usage API interface when account storage is encrypted', async () => {
    const module = await loadPersistenceModule();
    expect(module).not.toBeNull();
    const snapshot = createSnapshot();
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'e2ee' as const),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    };
    const scheduler = module!.createProviderAccountUsagePersistenceScheduler({
      api,
      now: () => 1_000,
      credentials: createCredentials(),
      randomBytes: (length) => new Uint8Array(length).fill(4),
      minFreshnessMs: 0,
    });

    await scheduler.recordInBandSnapshot(snapshot);
    await scheduler.flush(1_000);
    scheduler.dispose();

    expect(api.registerProviderAccountUsageSnapshotSealed).toHaveBeenCalledWith({
      recordId: snapshot.recordId,
      recordKey: snapshot.recordKey,
      sealed: {
        format: 'account_scoped_v1',
        ciphertext: expect.any(String),
      },
      metadata: expect.objectContaining({
        fetchedAt: 1_000,
        staleAfterMs: 300_000,
        status: 'ok',
        materialFingerprint: expect.any(String),
      }),
    });
    expect(api.registerProviderAccountUsageSnapshotPlain).not.toHaveBeenCalled();
  });

  it('passes explicit connected-service source context through sealed provider-account usage persistence', async () => {
    const module = await loadPersistenceModule();
    expect(module).not.toBeNull();
    const snapshot = createSnapshot();
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'e2ee' as const),
      registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
      registerProviderAccountUsageSnapshotSealed: vi.fn(async () => {}),
    };
    const scheduler = module!.createProviderAccountUsagePersistenceScheduler({
      api,
      now: () => 1_000,
      credentials: createCredentials(),
      randomBytes: (length) => new Uint8Array(length).fill(4),
      minFreshnessMs: 0,
    });

    await scheduler.recordInBandSnapshot(snapshot, {
      source: {
        serviceId: 'openai-codex',
        profileId: 'work',
        bindingKind: 'profile',
      },
    });
    await scheduler.flush(1_000);
    scheduler.dispose();

    expect(api.registerProviderAccountUsageSnapshotSealed).toHaveBeenCalledWith(expect.objectContaining({
      recordId: snapshot.recordId,
      recordKey: snapshot.recordKey,
      source: {
        serviceId: 'openai-codex',
        profileId: 'work',
        bindingKind: 'profile',
      },
    }));
  });
});
