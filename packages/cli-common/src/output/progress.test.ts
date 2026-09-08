import { afterEach, describe, expect, it, vi } from 'vitest';
import chalk from 'chalk';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStepPrinter, runCommandLogged } from './progress';

describe('createStepPrinter', () => {
  const writeSpy = vi.spyOn(process.stdout, 'write');

  afterEach(() => {
    writeSpy.mockReset();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('prints compact non-tty step lines', () => {
    writeSpy.mockImplementation(() => true);

    const printer = createStepPrinter({ enabled: true });
    printer.start('Installing');
    printer.stop('✓', 'Installing');

    const output = writeSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('- [..] Installing');
    expect(output).toContain('- [✓] Installing');
  });

  it('keeps redirected planet progress linear and free of terminal control bytes', () => {
    writeSpy.mockImplementation(() => true);
    const colorChalk = Object.create(chalk) as typeof chalk;
    colorChalk.level = 3;
    const printer = createStepPrinter({ appearance: 'planet', chalkLike: colorChalk });
    printer.start('Waiting for approval');
    printer.info('Request ended');
    printer.pause();
    const output = writeSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('Waiting for approval');
    expect(output).toContain('Request ended');
    expect(output).not.toMatch(/[\x1b\r]/u);
  });

  it.each(['message', 'no-motion', 'resize', 'resize-before-pause', 'dumb', 'child-output', 'spawn-error'] as const)('respects terminal ownership and motion controls: %s', async (scenario) => {
    vi.useFakeTimers();
    writeSpy.mockImplementation(() => true);
    const outTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const errTty = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
    const columns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 80 });
    vi.stubEnv('TERM', 'xterm-256color');
    vi.stubEnv('HAPPIER_NO_ANIMATION', '');
    if (scenario === 'no-motion') vi.stubEnv('HAPPIER_NO_ANIMATION', '1');
    if (scenario === 'dumb') vi.stubEnv('TERM', 'dumb');
    try {
      if (scenario === 'spawn-error') {
        const directory = await mkdtemp(join(tmpdir(), 'happier-progress-'));
        try {
          await expect(runCommandLogged({
            label: 'Missing child', cmd: join(directory, 'missing-command'), args: [],
            logPath: join(directory, 'command.log'),
          })).rejects.toThrow();
          expect(vi.getTimerCount()).toBe(0);
          const writesAfterFailure = writeSpy.mock.calls.length;
          vi.advanceTimersByTime(1000);
          expect(writeSpy.mock.calls).toHaveLength(writesAfterFailure);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
        return;
      }
      if (scenario === 'child-output') {
        const pending = runCommandLogged({
          label: 'Child command', cmd: process.execPath,
          args: ['-e', 'process.stdout.write("child output\\n")'],
          logPath: '', quiet: false,
        });
        try {
          // A real child owns inherited output until it exits.
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          await pending;
        }
        return;
      }
      const printer = createStepPrinter({ appearance: 'planet' });
      printer.start('Waiting');
      vi.advanceTimersByTime(600);
      if (scenario === 'no-motion' || scenario === 'dumb') {
        expect(writeSpy.mock.calls).toHaveLength(1);
        expect(writeSpy.mock.calls.map((call) => String(call[0])).join('')).not.toMatch(/[\x1b\r]/u);
      } else {
        expect(writeSpy.mock.calls.length).toBeGreaterThan(1);
      }
      if (scenario === 'resize') {
        Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 35 });
        const beforeResize = writeSpy.mock.calls.length;
        vi.advanceTimersByTime(200);
        expect(writeSpy.mock.calls).toHaveLength(beforeResize);
      }
      if (scenario === 'resize-before-pause') {
        Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 35 });
        writeSpy.mockClear();
      }
      printer.info('Approved');
      if (scenario === 'resize-before-pause') {
        expect(writeSpy.mock.calls.map((call) => String(call[0])).join('')).not.toMatch(/\x1b\[/u);
      }
      const writesAfterMessage = writeSpy.mock.calls.length;
      vi.advanceTimersByTime(1000);
      expect(writeSpy.mock.calls).toHaveLength(writesAfterMessage);
      expect(vi.getTimerCount()).toBe(0);
      expect(writeSpy.mock.calls.map((call) => String(call[0])).join('')).not.toContain('\x1b[2J');
    } finally {
      for (const [stream, key, descriptor] of [
        [process.stdout, 'isTTY', outTty], [process.stderr, 'isTTY', errTty],
        [process.stdout, 'columns', columns],
      ] as const) {
        if (descriptor) Object.defineProperty(stream, key, descriptor);
        else Reflect.deleteProperty(stream, key);
      }
    }
  });
});
