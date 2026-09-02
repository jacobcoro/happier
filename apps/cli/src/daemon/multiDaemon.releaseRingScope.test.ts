import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { reserveEphemeralPort } from '@/testkit/http/portUtils';

import { spawnSleepyDetachedProcess, spawnStoppableHttpDaemon } from './testkit/fakeDaemonLifecycle.testkit';

const envScope = createEnvKeyScope([
  'HAPPIER_HOME_DIR',
  'HAPPIER_RELEASE_RING',
  'HAPPIER_ACTIVE_SERVER_ID',
  'HAPPIER_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
]);

describe('multiDaemon release ring scoping', () => {
  let homeDir = '';

  afterEach(() => {
    envScope.restore();
    if (homeDir && homeDir.startsWith(tmpdir())) {
      try {
        rmSync(homeDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    vi.resetModules();
  });

  it('prefers the canonical daemon state file and still reports a legacy ring-scoped daemon state path when only that legacy file exists', async () => {
    homeDir = join(tmpdir(), `happier-multi-daemon-ring-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_RELEASE_RING: 'dev',
      HAPPIER_ACTIVE_SERVER_ID: 'cloud',
      HAPPIER_SERVER_URL: 'https://api.happier.dev',
      HAPPIER_WEBAPP_URL: 'https://app.happier.dev',
    });

    // Seed a minimal settings file with a cloud server profile so the list is deterministic.
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(
      join(homeDir, 'settings.json'),
      JSON.stringify(
        {
          servers: {
            cloud: {
              id: 'cloud',
              name: 'Cloud',
              serverUrl: 'https://api.happier.dev',
              webappUrl: 'https://app.happier.dev',
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const serverDir = join(homeDir, 'servers', 'cloud');
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(
      join(serverDir, 'daemon.dev.state.json'),
      JSON.stringify(
        {
          pid: 12345,
          httpPort: 7777,
          startedAt: Date.now(),
          startedWithCliVersion: '0.1.0',
        },
        null,
        2,
      ),
      'utf-8',
    );

    vi.resetModules();
    const { listDaemonStatusesForAllKnownServers } = await import('./multiDaemon');

    const entries = await listDaemonStatusesForAllKnownServers();
    const cloud = entries.find((entry) => entry.serverId === 'cloud');
    expect(cloud?.daemonStatePath).toBe(join(serverDir, 'daemon.dev.state.json'));
  });

  it('falls back to a valid legacy ring-scoped daemon state when the canonical file is unreadable', async () => {
    homeDir = join(tmpdir(), `happier-multi-daemon-canonical-invalid-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_RELEASE_RING: 'dev',
      HAPPIER_ACTIVE_SERVER_ID: 'cloud',
      HAPPIER_SERVER_URL: 'https://api.happier.dev',
      HAPPIER_WEBAPP_URL: 'https://app.happier.dev',
    });

    mkdirSync(homeDir, { recursive: true });
    writeFileSync(
      join(homeDir, 'settings.json'),
      JSON.stringify(
        {
          servers: {
            cloud: {
              id: 'cloud',
              name: 'Cloud',
              serverUrl: 'https://api.happier.dev',
              webappUrl: 'https://app.happier.dev',
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const serverDir = join(homeDir, 'servers', 'cloud');
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(join(serverDir, 'daemon.state.json'), '{not-json', 'utf-8');
    writeFileSync(
      join(serverDir, 'daemon.dev.state.json'),
      JSON.stringify(
        {
          pid: process.pid,
          httpPort: 7779,
          startedAt: Date.now(),
          startedWithCliVersion: '0.1.2',
        },
        null,
        2,
      ),
      'utf-8',
    );

    vi.resetModules();
    const { listDaemonStatusesForAllKnownServers } = await import('./multiDaemon');

    const entries = await listDaemonStatusesForAllKnownServers();
    const cloud = entries.find((entry) => entry.serverId === 'cloud');
    expect(cloud?.daemonStatePath).toBe(join(serverDir, 'daemon.dev.state.json'));
    expect(cloud?.daemon.pid).toBe(process.pid);
    expect(cloud?.daemon.running).toBe(true);
  });

  it('skips a stale canonical daemon state and uses a later live legacy ring-scoped state', async () => {
    homeDir = join(tmpdir(), `happier-multi-daemon-stale-canonical-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_RELEASE_RING: 'dev',
      HAPPIER_ACTIVE_SERVER_ID: 'cloud',
      HAPPIER_SERVER_URL: 'https://api.happier.dev',
      HAPPIER_WEBAPP_URL: 'https://app.happier.dev',
    });

    mkdirSync(homeDir, { recursive: true });
    writeFileSync(
      join(homeDir, 'settings.json'),
      JSON.stringify(
        {
          servers: {
            cloud: {
              id: 'cloud',
              name: 'Cloud',
              serverUrl: 'https://api.happier.dev',
              webappUrl: 'https://app.happier.dev',
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const serverDir = join(homeDir, 'servers', 'cloud');
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(
      join(serverDir, 'daemon.state.json'),
      JSON.stringify(
        {
          pid: Number.MAX_SAFE_INTEGER,
          httpPort: 7780,
          startedAt: Date.now(),
          startedWithCliVersion: '0.1.3',
        },
        null,
        2,
      ),
      'utf-8',
    );

    const sleepy = spawnSleepyDetachedProcess();
    try {
      writeFileSync(
        join(serverDir, 'daemon.dev.state.json'),
        JSON.stringify(
          {
            pid: sleepy.pid,
            httpPort: 7781,
            startedAt: Date.now(),
            startedWithCliVersion: '0.1.4',
          },
          null,
          2,
        ),
        'utf-8',
      );

      vi.resetModules();
      const { listDaemonStatusesForAllKnownServers } = await import('./multiDaemon');

      const entries = await listDaemonStatusesForAllKnownServers();
      const cloud = entries.find((entry) => entry.serverId === 'cloud');
      expect(cloud?.daemonStatePath).toBe(join(serverDir, 'daemon.dev.state.json'));
      expect(cloud?.daemon.pid).toBe(sleepy.pid);
      expect(cloud?.daemon.running).toBe(true);
      expect(cloud?.daemon.staleStateFile).toBe(false);
    } finally {
      await sleepy.kill();
    }
  });

  it('preserves live daemon state from another profile while retaining the active daemon pid', async () => {
    homeDir = join(tmpdir(), `happier-multi-daemon-orphan-reap-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_RELEASE_RING: 'dev',
      HAPPIER_ACTIVE_SERVER_ID: 'cloud',
      HAPPIER_SERVER_URL: 'https://api.happier.dev',
      HAPPIER_WEBAPP_URL: 'https://app.happier.dev',
    });

    mkdirSync(homeDir, { recursive: true });
    writeFileSync(
      join(homeDir, 'settings.json'),
      JSON.stringify(
        {
          activeServerId: 'cloud',
          servers: {
            cloud: {
              id: 'cloud',
              name: 'Cloud',
              serverUrl: 'https://api.happier.dev',
              webappUrl: 'https://app.happier.dev',
            },
            company: {
              id: 'company',
              name: 'Company',
              serverUrl: 'https://company.example.test',
              webappUrl: 'https://company.example.test',
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const activeServerDir = join(homeDir, 'servers', 'cloud');
    mkdirSync(activeServerDir, { recursive: true });
    writeFileSync(
      join(activeServerDir, 'daemon.state.json'),
      JSON.stringify(
        {
          pid: process.pid,
          httpPort: 7790,
          startedAt: Date.now(),
          startedWithCliVersion: '0.1.5',
          controlToken: 'active-token',
        },
        null,
        2,
      ),
      'utf-8',
    );

    const orphanPort = await reserveEphemeralPort();
    const orphan = spawnStoppableHttpDaemon(orphanPort);
    try {
      const orphanServerDir = join(homeDir, 'servers', 'company');
      mkdirSync(orphanServerDir, { recursive: true });
      const orphanState = JSON.stringify(
        {
          pid: orphan.pid,
          httpPort: orphanPort,
          startedAt: Date.now(),
          startedWithCliVersion: '0.1.4',
          controlToken: 'orphan-token',
        },
        null,
        2,
      );
      const canonicalOrphanStatePath = join(orphanServerDir, 'daemon.state.json');
      const legacyOrphanStatePath = join(orphanServerDir, 'daemon.dev.state.json');
      writeFileSync(canonicalOrphanStatePath, orphanState, 'utf-8');
      writeFileSync(legacyOrphanStatePath, orphanState, 'utf-8');
      const staleServerDir = join(homeDir, 'servers', 'stale');
      const staleStatePath = join(staleServerDir, 'daemon.state.json');
      const staleStateRaw = JSON.stringify({
        pid: Number.MAX_SAFE_INTEGER,
        httpPort: 7791,
        startedAt: Date.now(),
        startedWithCliVersion: '0.1.2',
      }) + '\n';
      mkdirSync(staleServerDir, { recursive: true });
      writeFileSync(staleStatePath, staleStateRaw, 'utf-8');

      vi.resetModules();
      const { reapSameHomeDaemonOrphansBeforeStart } = await import('./multiDaemon');

      const result = await reapSameHomeDaemonOrphansBeforeStart({ preservePids: [process.pid] });

      expect(result.stoppedPids).not.toContain(orphan.pid);
      expect(result.otherProfilePids).toContain(orphan.pid);
      expect(result.preservedPids).toContain(process.pid);
      expect(() => process.kill(process.pid, 0)).not.toThrow();
      expect(() => process.kill(orphan.pid, 0)).not.toThrow();
      expect(existsSync(canonicalOrphanStatePath)).toBe(true);
      expect(existsSync(legacyOrphanStatePath)).toBe(true);
      expect(readFileSync(staleStatePath, 'utf-8')).toBe(staleStateRaw);
    } finally {
      await orphan.kill();
    }
  });

  it('does not classify another profile as a failed active-profile stop when control is unavailable', async () => {
    homeDir = join(tmpdir(), `happier-multi-daemon-tokenless-orphan-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_RELEASE_RING: 'dev',
      HAPPIER_ACTIVE_SERVER_ID: 'cloud',
      HAPPIER_SERVER_URL: 'https://api.happier.dev',
      HAPPIER_WEBAPP_URL: 'https://app.happier.dev',
    });

    mkdirSync(homeDir, { recursive: true });
    writeFileSync(
      join(homeDir, 'settings.json'),
      JSON.stringify(
        {
          activeServerId: 'cloud',
          servers: {
            cloud: {
              id: 'cloud',
              name: 'Cloud',
              serverUrl: 'https://api.happier.dev',
              webappUrl: 'https://app.happier.dev',
            },
            company: {
              id: 'company',
              name: 'Company',
              serverUrl: 'https://company.example.test',
              webappUrl: 'https://company.example.test',
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const orphanPort = await reserveEphemeralPort();
    const orphan = spawnStoppableHttpDaemon(orphanPort);
    try {
      const orphanServerDir = join(homeDir, 'servers', 'company');
      mkdirSync(orphanServerDir, { recursive: true });
      const orphanStatePath = join(orphanServerDir, 'daemon.state.json');
      writeFileSync(
        orphanStatePath,
        JSON.stringify(
          {
            pid: orphan.pid,
            httpPort: orphanPort,
            startedAt: Date.now(),
            startedWithCliVersion: '0.1.6',
          },
          null,
          2,
        ),
        'utf-8',
      );

      vi.resetModules();
      const { reapSameHomeDaemonOrphansBeforeStart } = await import('./multiDaemon');

      const result = await reapSameHomeDaemonOrphansBeforeStart();

      expect(result.stoppedPids).not.toContain(orphan.pid);
      expect(result.failedPids).not.toContain(orphan.pid);
      expect(result.otherProfilePids).toContain(orphan.pid);
      expect(existsSync(orphanStatePath)).toBe(true);
      expect(() => process.kill(orphan.pid, 0)).not.toThrow();
    } finally {
      await orphan.kill();
    }
  });
});
