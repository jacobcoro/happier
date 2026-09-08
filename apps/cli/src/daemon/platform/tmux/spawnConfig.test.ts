import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildTmuxSpawnConfig } from './spawnConfig';

describe('tmux session resource policy', () => {
  const originalPlatform = process.platform;
  let commandDirectory: string | null = null;

  afterEach(async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
    vi.unstubAllEnvs();
    if (commandDirectory) await rm(commandDirectory, { recursive: true, force: true });
    commandDirectory = null;
  });

  async function provisionJobsProbe() {
    commandDirectory = await mkdtemp(join(tmpdir(), 'happier-tmux-resource-policy-'));
    // The executable is the OS boundary; launch/env selection remains real.
    await writeFile(join(commandDirectory, 'systemctl'), [
      '#!/bin/sh',
      'test "$DBUS_SESSION_BUS_ADDRESS" = "unix:path=/test/session-bus" || exit 1',
      'case "$*" in *happier-jobs.slice*) ;; *) exit 1 ;; esac',
      'printf "LoadState=loaded\\nCPUWeight=50\\nIOWeight=50\\nMemoryHigh=1073741824\\n"',
      '',
    ].join('\n'), { mode: 0o700 });
    vi.stubEnv('PATH', `${commandDirectory}${delimiter}${process.env.PATH ?? ''}`);
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/test/session-bus');
    vi.stubEnv('XDG_RUNTIME_DIR', '/test/runtime');
    vi.stubEnv('HAPPIER_DAEMON_STARTUP_SOURCE', 'background-service');
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
  }

  it('uses the same provisioned jobs scope and child environment as regular session launches', async () => {
    await provisionJobsProbe();
    const config = await buildTmuxSpawnConfig({
      agent: 'codex',
      directory: '/tmp',
      extraEnv: { HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP: '1' },
      launchOptions: { runtimeDecision: {
        runtime: 'node',
        argvPrefix: ['--no-warnings', '/test/admitted-runner.mjs'],
        env: { HAPPIER_TEST_RUNNER_ENV: 'retained' },
      } },
    });

    expect(config.commandTokens[0]).toBe('systemd-run');
    expect(config.commandTokens).toEqual(expect.arrayContaining([
      '--slice=happier-jobs.slice', '--nice=10', '/test/admitted-runner.mjs', 'codex',
    ]));
    expect(config.tmuxEnv.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/test/session-bus');
    expect(config.tmuxEnv.XDG_RUNTIME_DIR).toBe('/test/runtime');
    expect(config.tmuxEnv.HAPPIER_TEST_RUNNER_ENV).toBe('retained');
    expect(config.tmuxEnv.HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP).not.toBe('1');
  });
});
