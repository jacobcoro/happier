import { performance } from 'node:perf_hooks';

import { afterEach, describe, expect, it } from 'vitest';

import { createKeyedBackoffTracker } from '@/api/connection/scheduling';

import { createConnectedServiceQuotaPersistenceScheduler } from './connectedServices/quotas/createConnectedServiceQuotaPersistenceScheduler';
import { createDaemonControlApp } from './controlServer';
import { createDaemonHealthMonitor } from './health/daemonHealthMonitor';
import type { TrackedSession } from './types';

describe('daemon retained-worker and quota-503 load', () => {
  const disposers: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(disposers.splice(0).map(async (dispose) => await dispose()));
  });

  it('keeps session listing responsive with 48 retained workers and repeated quota 503s', async () => {
    const workers: TrackedSession[] = Array.from({ length: 48 }, (_, index) => ({
      pid: 30_000 + index,
      startedBy: 'daemon',
      happySessionId: `retained-${index}`,
      processCommandHash: `hash-${index}`,
      processInstanceFingerprint: `instance-${index}`,
      reattachedFromDiskMarker: true,
    }));
    const attemptCountByKey = new Map<string, number>();
    const quotaScheduler = createConnectedServiceQuotaPersistenceScheduler({
      run: async (key) => {
        attemptCountByKey.set(key, (attemptCountByKey.get(key) ?? 0) + 1);
        throw Object.assign(new Error('provider_account_usage_persistence_paused_after_failures'), {
          status: 503,
          code: 'provider_account_usage_persistence_paused_after_failures',
        });
      },
      maxConcurrent: 4,
      minKeyIntervalMs: 0,
      maxKeys: 64,
      maxKeyAgeMs: 60_000,
      maxPendingPayloadAgeMs: 60_000,
      maxConsecutiveFailures: 3,
      backoff: createKeyedBackoffTracker({
        baseDelayMs: 250,
        maxDelayMs: 1_000,
        jitterRatio: 0,
      }),
      shouldRetry: () => true,
    });
    disposers.push(() => quotaScheduler.dispose());

    const healthMonitor = createDaemonHealthMonitor({
      getWorkerPids: () => workers.map((worker) => worker.pid),
      sampleResources: async () => ({
        controllerRssBytes: 512 * 1024 ** 2,
        workerRssBytes: workers.length * 350 * 1024 ** 2,
        swapUsedBytes: 8 * 1024 ** 3,
        swapTotalBytes: 8 * 1024 ** 3,
        swapSource: 'load_fixture',
      }),
      getQuotaPersistenceCircuits: () => quotaScheduler.getCircuitSnapshot(),
      getStartupReconciliation: () => null,
    });
    const app = createDaemonControlApp({
      getChildren: () => workers,
      machineId: 'load-machine',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'success', sessionId: 'not-used' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'load-token',
      healthMonitor,
    });
    await app.ready();
    disposers.push(async () => await app.close());

    for (let index = 0; index < workers.length; index += 1) {
      quotaScheduler.enqueue(`openai-profile-${index}`, { materialFingerprint: `same-${index}` });
    }

    const listLatenciesMs: number[] = [];
    const listRequests = Array.from({ length: 200 }, async () => {
      const startedAt = performance.now();
      const response = await app.inject({
        method: 'POST',
        url: '/list',
        headers: { 'x-happier-daemon-token': 'load-token' },
      });
      listLatenciesMs.push(performance.now() - startedAt);
      expect(response.statusCode).toBe(200);
      expect(response.json().children).toHaveLength(48);
    });

    await Promise.all(listRequests);
    await quotaScheduler.flushAll(5_000);

    const healthResponse = await app.inject({
      method: 'POST',
      url: '/health',
      headers: { 'x-happier-daemon-token': 'load-token' },
    });
    expect(healthResponse.statusCode).toBe(200);
    const health = healthResponse.json().health;
    expect(health.workers.count).toBe(48);
    expect(health.status).toBe('error');
    expect(health.quotaPersistenceCircuits).toHaveLength(48);
    expect(health.quotaPersistenceCircuits[0].lastError).toMatchObject({
      status: 503,
      code: 'provider_account_usage_persistence_paused_after_failures',
      message: 'provider_account_usage_persistence_paused_after_failures',
    });
    const maxListLatencyMs = Math.max(...listLatenciesMs);
    const maxPersistenceAttemptsPerKey = Math.max(...attemptCountByKey.values());
    console.info(JSON.stringify({
      retainedWorkers: workers.length,
      listRequests: listLatenciesMs.length,
      maxListLatencyMs,
      quota503Keys: attemptCountByKey.size,
      maxPersistenceAttemptsPerKey,
    }));
    expect(maxListLatencyMs).toBeLessThan(2_000);
    expect(maxPersistenceAttemptsPerKey).toBeLessThanOrEqual(6);
  }, 20_000);
});
