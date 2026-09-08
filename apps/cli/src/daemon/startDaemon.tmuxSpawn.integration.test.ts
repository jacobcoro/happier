import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/spawnHappyCLI', () => {
  return {
    buildHappyCliSubprocessLaunchSpec: vi.fn((args: string[], options?: {
      runtimeDecision?: { runtime: 'node'; argvPrefix: string[]; env?: Record<string, string> };
    }) => {
      if (options?.runtimeDecision) {
        return {
          runtime: options.runtimeDecision.runtime,
          filePath: 'node',
          args: [...options.runtimeDecision.argvPrefix, ...args],
          env: options.runtimeDecision.env,
        };
      }
      const runtime = process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME === 'bun' ? 'bun' : 'node';
      if (runtime === 'bun') {
        return {
          runtime,
          filePath: 'bun',
          args: ['/virtual/dist/index.mjs', ...args],
        };
      }
      return {
        runtime,
        filePath: 'node',
        args: ['--no-warnings', '--no-deprecation', '/virtual/dist/index.mjs', ...args],
      };
    }),
    pruneHappyCliRunnerSnapshots: vi.fn(),
  };
});

import { buildTmuxSpawnConfig } from './platform/tmux/spawnConfig';

describe('daemon tmux spawn config', () => {
  const originalRuntimeOverride = process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME;
  const originalPath = process.env.PATH;

  afterEach(() => {
    if (originalRuntimeOverride === undefined) {
      delete process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME;
    } else {
      process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME = originalRuntimeOverride;
    }
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    vi.clearAllMocks();
  });

  it('uses merged env and bun runtime when configured', async () => {
    process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME = 'bun';
    process.env.PATH = '/bin';

    const cfg = await buildTmuxSpawnConfig({
      agent: 'claude',
      directory: '/tmp',
      extraEnv: {
        FOO: 'bar',
      },
      tmuxCommandEnv: {
        TMUX_TMPDIR: '/custom/tmux',
      },
      extraArgs: ['--happy-terminal-mode', 'tmux'],
    });

    expect(cfg.commandTokens).toContain('bun');
    expect(cfg.tmuxEnv.PATH).toBe('/bin');
    expect(cfg.tmuxEnv.FOO).toBe('bar');
    expect(cfg.tmuxCommandEnv.TMUX_TMPDIR).toBe('/custom/tmux');
    expect(cfg.commandTokens).toEqual(expect.arrayContaining(['--happy-terminal-mode', 'tmux']));
  });

  it('uses the admitted immutable runner decision for the tmux child command', async () => {
    const immutableEntrypoint = '/runtime/.runner-snapshots/0123456789abcdef/index.mjs';
    const cfg = await buildTmuxSpawnConfig({
      agent: 'claude',
      directory: '/tmp',
      extraEnv: {},
      extraArgs: ['--happy-terminal-mode', 'tmux'],
      launchOptions: {
        runtimeDecision: {
          runtime: 'node',
          argvPrefix: ['--no-warnings', '--no-deprecation', immutableEntrypoint],
          env: { HAPPIER_TEST_ADMITTED_CLOSURE: '0123456789abcdef' },
        },
      },
    });

    expect(cfg.commandTokens).toEqual(expect.arrayContaining([
      immutableEntrypoint,
      'claude',
      '--happy-terminal-mode',
      'tmux',
    ]));
    expect(cfg.tmuxEnv.HAPPIER_TEST_ADMITTED_CLOSURE).toBe('0123456789abcdef');
  });
});
