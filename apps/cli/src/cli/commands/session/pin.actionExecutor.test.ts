import { describe, expect, it, vi } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

const execute = vi.fn();
const createCliActionExecutorFromCredentials = vi.fn(() => ({ execute }));

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials,
}));

const credentials = {
  token: 'token_test',
  encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
};

describe('happier session pin/unpin (action executor)', () => {
  it('routes pin through ActionExecutor with the expected action id and args', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, sessionId: 'sess-1', pinned: true, pinnedAt: 123 },
    });

    const { handleSessionCommand } = await import('./handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['pin', 'sess-1', '--json'], { readCredentialsFn: async () => credentials });

      expect(execute).toHaveBeenCalledWith(
        'session.pin',
        { sessionId: 'sess-1' },
        { surface: 'cli', defaultSessionId: null },
      );
      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_pin',
        data: { sessionId: 'sess-1', pinned: true, pinnedAt: 123 },
      }));
    } finally {
      output.restore();
    }
  });

  it('routes unpin through ActionExecutor with the expected action id and args', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, sessionId: 'sess-1', pinned: false, pinnedAt: null },
    });

    const { handleSessionCommand } = await import('./handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['unpin', 'sess-1', '--json'], { readCredentialsFn: async () => credentials });

      expect(execute).toHaveBeenCalledWith(
        'session.unpin',
        { sessionId: 'sess-1' },
        { surface: 'cli', defaultSessionId: null },
      );
      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_unpin',
        data: { sessionId: 'sess-1', pinned: false, pinnedAt: null },
      }));
    } finally {
      output.restore();
    }
  });

  it('routes pins through ActionExecutor as an account-scoped read', async () => {
    execute.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, pins: [{ sessionId: 'sess-1', sortKey: null, pinnedAt: 123 }] },
    });

    const { handleSessionCommand } = await import('./handleSessionCommand');

    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['pins', '--json'], { readCredentialsFn: async () => credentials });

      expect(execute).toHaveBeenCalledWith(
        'session.pins.list',
        {},
        { surface: 'cli', defaultSessionId: null },
      );
      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_pins',
        data: { pins: [{ sessionId: 'sess-1', sortKey: null, pinnedAt: 123 }] },
      }));
    } finally {
      output.restore();
    }
  });
});
