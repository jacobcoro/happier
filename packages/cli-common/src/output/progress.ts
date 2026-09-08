import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import chalk from 'chalk';
import { isTerminalAnimationDisabled, renderNumericPlanet } from './planet.js';

type ChalkLike = typeof chalk;

function isTty(): boolean {
  return Boolean(process.stdout.isTTY && process.stderr.isTTY);
}

function spinnerFrames(): string[] {
  return ['|', '/', '-', '\\'];
}

function colorResult(chalkLike: ChalkLike, result: string): string {
  const normalized = String(result);
  if (chalkLike.level <= 0) return normalized;
  if (normalized === '✓') return chalkLike.green(normalized);
  if (normalized === 'x' || normalized === '✗') return chalkLike.red(normalized);
  if (normalized === '!') return chalkLike.yellow(normalized);
  return normalized;
}

function colorSpinner(chalkLike: ChalkLike, frame: string): string {
  return chalkLike.level <= 0 ? String(frame) : chalkLike.cyan(String(frame));
}

export function createStepPrinter({ enabled = true, chalkLike = chalk, appearance = 'compact' }: Readonly<{
  enabled?: boolean;
  chalkLike?: ChalkLike;
  appearance?: 'compact' | 'planet';
}> = {}) {
  if (!enabled) {
    return {
      start: () => {},
      stop: () => {},
      info: () => {},
      pause: () => {},
    };
  }

  const tty = enabled && isTty() && process.env.TERM !== 'dumb';
  const animate = tty && !isTerminalAnimationDisabled();
  const color = tty && !process.env.NO_COLOR;
  const colors = chalkLike;
  const frames = spinnerFrames();
  let timer: ReturnType<typeof setInterval> | null = null;
  let idx = 0;
  let currentLine = '';
  let drawnRows = 0;
  let initialColumns = 0;
  let initialRows = 0;

  const write = (value: string) => process.stdout.write(value);
  const resized = () => (process.stdout.columns ?? 80) !== initialColumns || (process.stdout.rows ?? 24) !== initialRows;

  // Called before yielding the terminal to another message/prompt/child.
  // Never move above our own region (in particular, never redraw an auth QR).
  const pause = () => {
    if (timer) clearInterval(timer);
    timer = null;
    if (resized()) {
      // Resize may occur immediately before completion, not just on a tick.
      // The terminal owns any reflowed output; leave it intact.
      if (currentLine) write('\n');
    } else if (drawnRows > 0) {
      write(`\r\x1b[${drawnRows}A\x1b[J`);
    } else if (currentLine) {
      write('\r\x1b[2K');
    }
    currentLine = '';
    drawnRows = 0;
  };

  const start = (label: string) => {
    pause();
    if (!animate) {
      write(`- [..] ${label}\n`);
      return;
    }
    initialColumns = process.stdout.columns ?? 80;
    initialRows = process.stdout.rows ?? 24;
    if (appearance === 'planet') {
      // Keep status text outside the redrawn region: URLs/long labels can wrap
      // freely without invalidating our cursor geometry.
      write(`${label}\n`);
      if (initialColumns < 40 || initialRows < 18) return;
      const startedAt = Date.now();
      const draw = () => {
        if (resized()) {
          // Once resized, let the terminal keep its reflowed scrollback. Do
          // not guess where those previous rows moved or erase user content.
          if (timer) clearInterval(timer);
          timer = null;
          drawnRows = 0;
          return;
        }
        if (drawnRows > 0) write(`\x1b[${drawnRows}A`);
        const rows = renderNumericPlanet({ seconds: (Date.now() - startedAt) / 1000, chalkLike: colors, color });
        write(rows.map((row) => `\r\x1b[2K${row}\n`).join(''));
        drawnRows = rows.length;
      };
      draw();
      timer = setInterval(draw, 160);
      timer.unref?.();
      return;
    }
    // Long compact labels use the linear mode rather than wrapping a cursor
    // animation onto multiple unowned rows.
    if (label.length + 8 >= initialColumns) { write(`- [..] ${label}\n`); return; }
    currentLine = `- [${color ? colorSpinner(colors, frames[idx % frames.length] ?? '|') : frames[idx % frames.length]}] ${label}`;
    write(currentLine);
    timer = setInterval(() => {
      idx += 1;
      if (resized()) {
        if (timer) clearInterval(timer);
        timer = null;
        currentLine = '';
        write('\n');
        return;
      }
      const next = `- [${color ? colorSpinner(colors, frames[idx % frames.length] ?? '|') : frames[idx % frames.length]}] ${label}`;
      const pad = currentLine.length > next.length ? ' '.repeat(currentLine.length - next.length) : '';
      currentLine = next;
      write(`\r${next}${pad}`);
    }, 120);
    timer.unref?.();
  };

  const stop = (result: string, label: string) => {
    pause();
    write(`- [${color ? colorResult(colors, result) : result}] ${label}\n`);
  };

  const info = (line: string) => {
    pause();
    write(`${line}\n`);
  };

  return { start, stop, info, pause };
}

export async function runCommandLogged({
  label,
  cmd,
  args,
  cwd,
  env,
  logPath,
  showSteps = true,
  quiet = true,
}: Readonly<{
  label: string;
  cmd: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logPath: string;
  showSteps?: boolean;
  quiet?: boolean;
}>) {
  const steps = createStepPrinter({ enabled: showSteps });
  if (quiet) {
    await mkdir(dirname(logPath), { recursive: true }).catch(() => {});
  }

  // An inherited child owns the terminal, so only buffered commands animate.
  if (quiet) steps.start(label);
  else steps.info(`- [..] ${label}`);

  let logStream: ReturnType<typeof createWriteStream> | null = null;
  try {
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    if (quiet) {
      logStream = createWriteStream(logPath, { flags: 'a' });
      child.stdout?.on('data', (d) => {
        const s = d.toString();
        stdout += s;
        logStream?.write(s);
      });
      child.stderr?.on('data', (d) => {
        const s = d.toString();
        stderr += s;
        logStream?.write(s);
      });
    }

    const res = await new Promise<Readonly<{ code: number; signal: NodeJS.Signals | null }>>((resolvePromise, rejectPromise) => {
      child.on('error', rejectPromise);
      child.on('close', (code, signal) => resolvePromise({ code: code ?? 1, signal: signal ?? null }));
    });

    if (res.code === 0) {
      steps.stop('✓', label);
      return { ok: true, code: 0, stdout, stderr, logPath };
    }

    steps.stop('x', label);
    const err = new Error(`${cmd} failed (code=${res.code}${res.signal ? `, sig=${res.signal}` : ''})`);
    (err as Error & {
      code?: string;
      exitCode?: number;
      signal?: NodeJS.Signals | null;
      stdout?: string;
      stderr?: string;
      logPath?: string;
    }).code = 'EEXIT';
    (err as Error & { exitCode?: number }).exitCode = res.code;
    (err as Error & { signal?: NodeJS.Signals | null }).signal = res.signal;
    (err as Error & { stdout?: string }).stdout = stdout;
    (err as Error & { stderr?: string }).stderr = stderr;
    (err as Error & { logPath?: string }).logPath = logPath;
    throw err;
  } finally {
    // Spawn errors reject before a normal exit status exists. Always release
    // terminal ownership and the log stream before the caller reports failure.
    steps.pause();
    logStream?.end();
  }
}
