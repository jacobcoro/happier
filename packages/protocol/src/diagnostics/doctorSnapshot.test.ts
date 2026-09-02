import { describe, expect, it } from 'vitest';

import { DoctorSnapshotSchema, parseDoctorSnapshotSafe } from './doctorSnapshot.js';

describe('DoctorSnapshotSchema', () => {
  it('accepts a valid snapshot and parseDoctorSnapshotSafe redacts userinfo/query/hash', () => {
    const raw = JSON.stringify({
      capturedAt: '2026-02-23T00:00:00.000Z',
      server: {
        activeServerId: 'cloud',
        serverUrl: 'https://admin:secret@api.happier.dev/path?token=abc#frag',
        publicServerUrl: 'https://api.happier.dev/path?token=abc',
        webappUrl: 'https://app.happier.dev/?token=abc',
      },
      accountId: 'acct_123',
      settings: {
        activeServerId: 'cloud',
        servers: [
          {
            id: 'cloud',
            name: 'Happier Cloud',
            serverUrl: 'https://admin:secret@api.happier.dev/path?token=abc',
            webappUrl: 'https://app.happier.dev/?token=abc',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: 0,
          },
        ],
        knownAccountIds: ['acct_123'],
      },
      installations: {
        happier: {
          activeInvocation: {
            path: '/Users/test/.local/bin/hdev',
            realPath: '/Users/test/.happier/cli-dev/current/happier',
            invokerName: 'hdev',
            ring: 'dev',
            version: '0.2.5-dev.7.1',
            installationId: 'firstPartyManaged:dev',
          },
          installations: [
            {
              id: 'firstPartyManaged:dev',
              source: 'firstPartyManaged',
              components: ['happier-cli'],
              ring: 'dev',
              version: '0.2.5-dev.7.1',
              path: '/Users/test/.happier/cli-dev/current/happier?token=abc',
              realPath: '/Users/test/.happier/cli-dev/versions/0.2.5-dev.7.1/happier?token=abc',
              shimName: 'hdev',
              onPath: true,
              managedRoot: '/Users/test/.happier/cli-dev',
            },
          ],
        },
      },
      services: {
        happier: {
          services: [
            {
              id: 'svc-default',
              serviceType: 'daemon',
              platform: 'darwin',
              backend: 'launchd',
              label: 'com.happier.cli.daemon.default',
              verification: 'verified',
              targetMode: 'default-following',
              ring: 'dev',
              instanceId: 'default',
              scope: 'user',
              definitionPath: '/Users/test/Library/LaunchAgents/com.happier.cli.daemon.default.plist',
              executablePath: null,
              serverUrl: 'https://api.happier.dev/path?token=abc',
              publicServerUrl: 'https://relay.happier.dev/path?token=abc',
              installed: true,
              running: true,
              configuredCliVersion: '0.2.5-dev.7.1',
              runningCliVersion: '0.2.5-dev.7.1',
            },
          ],
        },
      },
      relays: {
        happier: {
          relays: [
            {
              id: 'dev:user',
              ring: 'dev',
              scope: 'user',
              installed: true,
              version: '0.2.5-dev.7.1',
              relayUrl: 'http://127.0.0.1:4400/?token=abc#frag',
              healthy: true,
              serviceActive: true,
              serviceEnabled: true,
              warnings: ['Legacy relay install detected at http://127.0.0.1:4400/?token=abc'],
            },
          ],
        },
      },
      warnings: [
        {
          code: 'backgroundServiceRepairRecommended',
          severity: 'warning',
          message: 'Background service repair is recommended.',
          repairCommands: ['happier doctor repair --yes'],
        },
      ],
      daemonStatus: {
        server: {
          activeServerId: 'cloud',
          serverUrl: 'https://admin:secret@api.happier.dev/path?token=abc#frag',
          localServerUrl: 'http://127.0.0.1:3005/?token=abc',
          publicServerUrl: 'https://api.happier.dev/path?token=abc',
          webappUrl: 'https://app.happier.dev/?token=abc',
          comparableKey: 'https://api.happier.dev',
        },
        daemon: {
          running: true,
          pid: 4321,
          httpPort: null,
          startedWithCliVersion: '1.2.3',
          startedWithPublicReleaseChannel: 'preview',
          startupSource: 'background-service',
          serviceManaged: true,
          serviceLabel: 'com.happier.cli.daemon.default',
        },
        service: {
          installed: true,
          running: true,
        },
        auth: {
          authenticated: true,
          machineRegistered: false,
          machineId: null,
          needsAuth: true,
          accountId: 'acct_123',
        },
        health: {
          status: 'warning',
          observedAtMs: 1234,
          workers: { count: 48, warningLimit: 40, hardLimit: 64 },
          resources: {
            controllerRssBytes: 100,
            workerRssBytes: 200,
            swapUsedBytes: 75,
            swapTotalBytes: 100,
            swapSource: 'test',
            rssWarningBytes: 1,
            rssHardBytes: 2,
            swapWarningRatio: 0.25,
            swapHardRatio: 0.75,
          },
          sessionListQueries: { active: 0, queued: 0, peakQueued: 3, rejected: 0, maxConcurrent: 2, maxQueued: 64 },
          quotaPersistenceCircuits: [],
          startupReconciliation: null,
          alerts: [{ code: 'worker_count_warning', severity: 'warning', message: 'Worker count is high' }],
        },
      },
    });

    const parsed = parseDoctorSnapshotSafe(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected ok');

    expect(DoctorSnapshotSchema.safeParse(parsed.snapshot).success).toBe(true);
    const serialized = JSON.stringify(parsed.snapshot);
    expect(serialized).not.toContain('admin:secret');
    expect(serialized).not.toContain('?token=');
    expect(serialized).not.toContain('#frag');
    expect(parsed.snapshot.daemonStatus?.server.localServerUrl).toBe('http://127.0.0.1:3005');
    expect(parsed.snapshot.daemonStatus?.daemon.startedWithCliVersion).toBe('1.2.3');
    expect(parsed.snapshot.daemonStatus?.daemon.startedWithPublicReleaseChannel).toBe('preview');
    expect(parsed.snapshot.daemonStatus?.daemon.startupSource).toBe('background-service');
    expect(parsed.snapshot.daemonStatus?.daemon.serviceManaged).toBe(true);
    expect(parsed.snapshot.daemonStatus?.daemon.serviceLabel).toBe('com.happier.cli.daemon.default');
    expect(parsed.snapshot.daemonStatus?.health?.workers.count).toBe(48);
    expect(parsed.snapshot.daemonStatus?.health?.alerts[0]?.code).toBe('worker_count_warning');
    expect(parsed.snapshot.installations?.happier?.activeInvocation?.ring).toBe('dev');
    expect(parsed.snapshot.services?.happier?.services[0]?.publicServerUrl).toBe('https://relay.happier.dev/path');
    expect(parsed.snapshot.services?.happier?.services[0]?.configuredCliVersion).toBe('0.2.5-dev.7.1');
    expect(parsed.snapshot.relays?.happier?.relays[0]?.relayUrl).toBe('http://127.0.0.1:4400');
    expect(parsed.snapshot.relays?.happier?.relays[0]?.warnings).toEqual(['Legacy relay install detected at http://127.0.0.1:4400']);
    expect(parsed.snapshot.warnings?.[0]?.repairCommands).toEqual(['happier doctor repair --yes']);
  });

  it('returns a stable error for invalid JSON', () => {
    const parsed = parseDoctorSnapshotSafe('{not json}');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected error');
    expect(parsed.error).toMatch(/invalid json/i);
  });
});
