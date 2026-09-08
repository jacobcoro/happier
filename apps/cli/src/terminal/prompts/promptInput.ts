/**
 * Terminal prompt helpers
 *
 * Shared interactive input helpers for CLI flows (server add flows, OAuth paste fallback, etc).
 */

import { closeSync, existsSync, openSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createInterface } from 'node:readline';

export type PromptAnimation = Readonly<{
  animate?: boolean;
  intervalMs?: number;
  render: (elapsedSeconds: number) => string;
  onMove?: (delta: -1 | 1) => void;
  answerOnEmpty?: () => string;
}>;

type PromptOptions = Readonly<{
  animation?: PromptAnimation;
}>;

/**
 * Decide whether we can ask the user a question, given what the process can see.
 *
 * Pure so the `curl | bash` case can be tested without a terminal.
 */
export function resolveInteractiveTerminal(params: Readonly<{
  stdinIsTty: boolean;
  stdoutIsTty: boolean;
  platform: NodeJS.Platform | string;
  hasControllingTty: () => boolean;
  /**
   * A caller has stated that nobody is watching this run, whatever the terminal
   * looks like. Installers set this for their whole run, and `happier setup
   * --yes` sets it for the commands it spawns — a controlling terminal is still
   * attached in both cases, so nothing below can tell.
   */
  unattended?: boolean;
}>): boolean {
  if (params.unattended) {
    return false;
  }
  if (params.stdinIsTty && params.stdoutIsTty) {
    return true;
  }
  if (params.platform === 'win32') {
    return false;
  }
  return params.hasControllingTty();
}

/**
 * A device node at /dev/tty is not proof of a terminal — in a container it can
 * exist and still fail to open with ENXIO. Opening it is the only real check.
 */
function hasControllingTty(): boolean {
  let fd: number | null = null;
  try {
    fd = openSync('/dev/tty', 'r+');
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Best effort: we only opened it to find out whether we could.
      }
    }
  }
}

/**
 * Whether the CLI can prompt.
 *
 * `process.stdin` is not the whole story. Under `curl … | bash -s -- --run <cmd>`
 * the installer hands us an exhausted pipe on stdin while the user is still sat
 * at a terminal — and `promptInput` below already prompts through a freshly
 * opened /dev/tty in exactly that case. Gating on stdin alone made every
 * installer-invoked command run blind, which is why those call sites had to pass
 * `--yes`.
 */
export function isInteractiveTerminal(): boolean {
  return resolveInteractiveTerminal({
    stdinIsTty: Boolean(process.stdin.isTTY),
    stdoutIsTty: Boolean(process.stdout.isTTY),
    platform: process.platform,
    hasControllingTty,
    unattended: String(process.env.HAPPIER_NONINTERACTIVE ?? '') === '1',
  });
}

/**
 * Read a line from the user.
 *
 * On Unix we always prompt through a freshly-opened `/dev/tty` when it's
 * available, regardless of what `process.stdin` looks like. This matters for
 * the `curl | bash` installer path, where the installer wraps
 * `doctor repair </dev/tty` but Node's readline-on-the-redirected-fd can
 * wedge the terminal (typed keys don't register, Ctrl+C is swallowed).
 * Opening `/dev/tty` fresh sidesteps that entirely and also works for
 * normal interactive runs (same physical device, just a different fd).
 *
 * On Windows (or if `/dev/tty` isn't accessible), fall back to
 * `process.stdin` / `process.stdout`.
 */
export async function promptInput(prompt: string, options: PromptOptions = {}): Promise<string> {
  // Keep the established canonical-mode /dev/tty fallback static. When stdin
  // and stdout are the terminal, readline can atomically redraw its own prompt
  // and current input without competing terminal writes.
  if (options.animation && process.stdin.isTTY && process.stdout.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let timer: ReturnType<typeof setInterval> | null = null;
    let onKeypress: ((value: string, key: Readonly<{ name?: string }>) => void) | null = null;
    try {
      return await new Promise<string>((resolve, reject) => {
        const startedAt = Date.now();
        const initialColumns = process.stdout.columns;
        const initialRows = process.stdout.rows;
        const finish = (value: string): void => {
          if (timer) clearInterval(timer);
          timer = null;
          rl.removeListener('close', onClose);
          if (onKeypress) process.stdin.removeListener('keypress', onKeypress);
          resolve(value);
        };
        const onClose = (): void => {
          if (timer) clearInterval(timer);
          timer = null;
          if (onKeypress) process.stdin.removeListener('keypress', onKeypress);
          const error = new Error('Terminal prompt closed');
          error.name = 'AbortError';
          reject(error);
        };
        rl.once('close', onClose);
        let redrawEnabled = true;
        const canRedraw = (): boolean => {
          const cursor = rl.getCursorPos();
          return process.stdout.columns === initialColumns
            && process.stdout.rows === initialRows
            && !(typeof initialRows === 'number' && cursor.rows >= initialRows - 1);
        };
        const stopRedraw = (): void => {
            if (timer) clearInterval(timer);
            timer = null;
            redrawEnabled = false;
        };
        const redraw = (): void => {
          if (!canRedraw()) {
            stopRedraw();
            return;
          }
          const elapsedSeconds = options.animation!.animate === false ? 0 : (Date.now() - startedAt) / 1000;
          rl.setPrompt(options.animation!.render(elapsedSeconds));
          rl.prompt(true);
        };
        onKeypress = (_value, key) => {
          if (key.name === 'escape') {
            if (timer) clearInterval(timer);
            timer = null;
            rl.removeListener('close', onClose);
            process.stdin.removeListener('keypress', onKeypress!);
            const error = new Error('Terminal prompt aborted');
            error.name = 'AbortError';
            reject(error);
            return;
          }
          if (!redrawEnabled || (key.name !== 'up' && key.name !== 'down')) return;
          if (!canRedraw()) {
            stopRedraw();
            return;
          }
          options.animation!.onMove?.(key.name === 'up' ? -1 : 1);
          redraw();
        };
        process.stdin.on('keypress', onKeypress);
        if (options.animation!.animate !== false) {
          timer = setInterval(redraw, Math.max(40, options.animation!.intervalMs ?? 120));
          timer.unref?.();
        }
        try {
          rl.question(prompt, (value) => finish(value === '' ? options.animation?.answerOnEmpty?.() ?? value : value));
        } catch (error) {
          if (timer) clearInterval(timer);
          timer = null;
          rl.removeListener('close', onClose);
          if (onKeypress) process.stdin.removeListener('keypress', onKeypress);
          reject(error);
        }
      });
    } finally {
      if (timer) clearInterval(timer);
      rl.close();
    }
  }

  if (process.platform !== 'win32' && existsSync('/dev/tty')) {
    const ttyHandle = await open('/dev/tty', 'r+').catch(() => null);
    if (ttyHandle) {
      const input = ttyHandle.createReadStream();
      const output = ttyHandle.createWriteStream();
      // `terminal: false` — FileHandle-backed streams on /dev/tty don't expose
      // the TTY setRawMode API, so readline can't actually switch to raw mode.
      // If we let readline believe it's in terminal mode anyway, it emits its
      // own character echo while the kernel (canonical mode) ALSO echoes each
      // keystroke → you see "yy" on screen. With `terminal: false`, readline
      // operates in line-mode and the kernel handles echo cleanly.
      const rl = createInterface({ input, output, terminal: false });
      try {
        output.write(prompt);
        return await new Promise<string>((resolve) => {
          rl.once('line', (line) => resolve(line));
        });
      } finally {
        rl.close();
        input.destroy();
        output.destroy();
        await ttyHandle.close().catch(() => undefined);
      }
    }
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => rl.question(prompt, resolve));
  } finally {
    rl.close();
  }
}
