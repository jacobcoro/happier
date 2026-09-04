import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

describe('happier session pin/unpin/pins (integration)', () => {
  const envKeys = ['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR'] as const;
  let envScope = createEnvKeyScope(envKeys);
  let server: Server | null = null;
  let happyHomeDir = '';

  const sessionId = 'sess_integration_pin_00000';
  const credentials = {
    token: 'token_test',
    encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
  };

  // Mirrors the server's storage semantics: the pin row is keyed by (account, session), a pin
  // write upserts it and an unpin write deletes it if present. Repeating either call is a
  // no-op success, which is what the CLI path must preserve.
  let pinnedAt: number | null = null;
  let pinWriteCount = 0;

  beforeEach(async () => {
    happyHomeDir = await createTempDir('happier-cli-session-pin-');
    pinnedAt = null;
    pinWriteCount = 0;

    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

      if (req.method === 'GET' && url.pathname === `/v2/sessions/${sessionId}`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          session: {
            id: sessionId,
            seq: 1,
            createdAt: 1,
            updatedAt: 2,
            active: false,
            activeAt: 0,
            metadata: 'metadata_ciphertext',
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            pendingCount: 0,
            pendingVersion: 0,
            dataEncryptionKey: null,
            share: null,
            archivedAt: null,
          },
        }));
        return;
      }

      if (req.method === 'PUT' && url.pathname === `/v2/session-organization/pins/${sessionId}`) {
        const body = await new Promise<string>((resolve) => {
          let raw = '';
          req.on('data', (chunk) => { raw += String(chunk); });
          req.on('end', () => resolve(raw));
        });
        const parsed = JSON.parse(body || '{}') as { pinned?: boolean };
        pinWriteCount += 1;
        if (parsed.pinned === true) {
          pinnedAt = pinnedAt ?? 1_700_000_000_000;
        } else {
          pinnedAt = null;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          pin: pinnedAt === null ? null : { sessionId, sortKey: null, pinnedAt },
        }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v2/session-organization') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          snapshot: {
            schemaVersion: 1,
            version: 1,
            pins: pinnedAt === null ? [] : [{ sessionId, sortKey: null, pinnedAt }],
            folders: [],
            folderAssignments: [],
            tags: [],
            tagAssignments: [],
            orderEntries: [],
            labels: [],
          },
        }));
        return;
      }

      res.statusCode = 404;
      res.end();
    });

    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to resolve integration server address');

    process.env.HAPPIER_SERVER_URL = `http://127.0.0.1:${address.port}`;
    process.env.HAPPIER_WEBAPP_URL = 'http://127.0.0.1:3000';
    process.env.HAPPIER_HOME_DIR = happyHomeDir;

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server!.close((e) => (e ? reject(e) : resolve())));
    }
    server = null;
    if (happyHomeDir) {
      await removeTempDir(happyHomeDir);
      happyHomeDir = '';
    }

    envScope.restore();
    envScope = createEnvKeyScope(envKeys);

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  it('pins a session and reads the pin back from the server', async () => {
    const { handleSessionCommand } = await import('./index');

    const pinOutput = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['pin', sessionId, '--json'], { readCredentialsFn: async () => credentials });
      const parsed = pinOutput.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_pin');
      expect(parsed.data?.sessionId).toBe(sessionId);
      expect(parsed.data?.pinned).toBe(true);
    } finally {
      pinOutput.restore();
    }

    const listOutput = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['pins', '--json'], { readCredentialsFn: async () => credentials });
      const parsed = listOutput.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_pins');
      expect(parsed.data?.pins).toEqual([{ sessionId, sortKey: null, pinnedAt: 1_700_000_000_000 }]);
    } finally {
      listOutput.restore();
    }
  });

  it('pins an already-pinned session quietly and leaves one pin behind', async () => {
    const { handleSessionCommand } = await import('./index');

    for (const attempt of [1, 2]) {
      const output = captureConsoleJsonOutput();
      try {
        await handleSessionCommand(['pin', sessionId, '--json'], { readCredentialsFn: async () => credentials });
        const parsed = output.json();
        expect(parsed.ok, `attempt ${attempt}`).toBe(true);
        expect(parsed.data?.pinned).toBe(true);
        expect(parsed.data?.pinnedAt).toBe(1_700_000_000_000);
      } finally {
        output.restore();
      }
    }

    expect(pinWriteCount).toBe(2);

    const listOutput = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['pins', '--json'], { readCredentialsFn: async () => credentials });
      expect(listOutput.json().data?.pins).toHaveLength(1);
    } finally {
      listOutput.restore();
    }
  });

  it('unpins a session and unpinning again stays a quiet success', async () => {
    const { handleSessionCommand } = await import('./index');

    const pinOutput = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['pin', sessionId, '--json'], { readCredentialsFn: async () => credentials });
    } finally {
      pinOutput.restore();
    }

    for (const attempt of [1, 2]) {
      const output = captureConsoleJsonOutput();
      try {
        await handleSessionCommand(['unpin', sessionId, '--json'], { readCredentialsFn: async () => credentials });
        const parsed = output.json();
        expect(parsed.ok, `attempt ${attempt}`).toBe(true);
        expect(parsed.kind).toBe('session_unpin');
        expect(parsed.data?.pinned).toBe(false);
        expect(parsed.data?.pinnedAt).toBe(null);
      } finally {
        output.restore();
      }
    }

    const listOutput = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['pins', '--json'], { readCredentialsFn: async () => credentials });
      expect(listOutput.json().data?.pins).toEqual([]);
    } finally {
      listOutput.restore();
    }
  });

  it('reports the pin limit as an expected failure instead of throwing', async () => {
    server!.removeAllListeners('request');
    server!.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (req.method === 'GET' && url.pathname === `/v2/sessions/${sessionId}`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          session: {
            id: sessionId, seq: 1, createdAt: 1, updatedAt: 2, active: false, activeAt: 0,
            metadata: 'metadata_ciphertext', metadataVersion: 0, agentState: null, agentStateVersion: 0,
            pendingCount: 0, pendingVersion: 0, dataEncryptionKey: null, share: null, archivedAt: null,
          },
        }));
        return;
      }
      if (req.method === 'PUT' && url.pathname === `/v2/session-organization/pins/${sessionId}`) {
        res.statusCode = 409;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'session-pin-limit-exceeded' }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    const { handleSessionCommand } = await import('./index');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['pin', sessionId, '--json'], { readCredentialsFn: async () => credentials });
      const parsed = output.json();
      expect(parsed.ok).toBe(false);
      expect(parsed.error?.code).toBe('session_pin_limit_exceeded');
    } finally {
      output.restore();
    }
  });
});
