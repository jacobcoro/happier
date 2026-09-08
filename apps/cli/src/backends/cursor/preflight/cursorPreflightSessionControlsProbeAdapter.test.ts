import { afterEach, describe, expect, it } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import {
  createProbeTempDir,
  resolveAcpSdkEntryFromCwd,
  writeExecutableScript,
} from '@/capabilities/probes/agentModelsProbe.testkit';

import { cursorPreflightSessionControlsProbeAdapter } from './cursorPreflightSessionControlsProbeAdapter';

const envKeys = ['HAPPIER_CURSOR_PATH', 'PATH'] as const;
let envScope = createEnvKeyScope(envKeys);

afterEach(() => {
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);
});

async function writeFakeCursorAgent(params: {
  dir: string;
  sdkEntry: string;
}): Promise<string> {
  const agentPath = `${params.dir}/cursor-agent.mjs`;
  await writeExecutableScript(agentPath, `#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

if (process.argv.includes("models")) {
  process.stdout.write([
    "Available models:",
    "composer-2.5 - Composer 2.5",
    "composer-2.5-fast - Composer 2.5 Fast",
    "gpt-5.5 - GPT-5.5",
    "gpt-5.5-low - GPT-5.5 Low",
    "gpt-5.5-high-fast - GPT-5.5 High Fast",
    "claude-fable-5 - Fable 5",
    "claude-fable-5-thinking-low - Fable 5 Thinking Low",
    "claude-fable-5-thinking-max-fast - Fable 5 Thinking Max Fast",
    "claude-opus-4-8 - Opus 4.8",
    "claude-opus-4-8-thinking-low - Opus 4.8 Thinking Low",
    "claude-opus-4-8-thinking-max-fast - Opus 4.8 Thinking Max Fast",
    "gemini-3.1-pro - Gemini 3.1 Pro",
    ""
  ].join("\\n"));
  process.exit(0);
}

if (!process.argv.includes("acp")) {
  process.exit(1);
}

const acp = await import(pathToFileURL(${JSON.stringify(params.sdkEntry)}).href);

const objectParams = { parse: (value) => value };
const app = acp.agent({ name: "happier-cursor-preflight-agent" })
  .onRequest("initialize", async () => {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
      authMethods: [{ id: "cursor_login", name: "Cursor Login" }]
    };
  })
  .onRequest("session/new", async () => {
    return {
      sessionId: "cursor-preflight-test",
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "gpt-5.5",
          options: [
            { value: "default", name: "Use CLI settings" },
            { value: "composer-2.5", name: "Composer 2.5" },
            { value: "gpt-5.5", name: "GPT-5.5" },
            { value: "claude-fable-5", name: "Fable 5" },
            { value: "claude-opus-4-8", name: "Opus 4.8" },
            { value: "gemini-3.1-pro", name: "Gemini 3.1 Pro" }
          ]
        },
        {
          id: "context",
          name: "Context",
          category: "model_config",
          type: "select",
          currentValue: "272k",
          options: [
            { value: "272k", name: "272K" },
            { value: "1m", name: "1M" }
          ]
        },
        {
          id: "reasoning",
          name: "Reasoning",
          category: "thought_level",
          type: "select",
          currentValue: "high",
          options: [
            { value: "none", name: "None" },
            { value: "low", name: "Low" },
            { value: "medium", name: "Medium" },
            { value: "high", name: "High" },
            { value: "extra-high", name: "Extra High" }
          ]
        },
        {
          id: "fast",
          name: "Fast",
          category: "model_config",
          type: "boolean",
          currentValue: "false",
          options: [
            { value: "false", name: "Off" },
            { value: "true", name: "On" }
          ]
        }
      ]
    };
  })
  .onRequest("authenticate", async () => ({}))
  .onRequest("session/prompt", async () => ({ stopReason: "end_turn" }))
  .onNotification("session/cancel", async () => {})
  .onRequest("cursor/list_available_models", objectParams, async () => {
    return {
      models: [
        {
          value: "cursor-exclusive",
          name: "Cursor Exclusive",
          configOptions: [
            {
              id: "context",
              name: "Context",
              category: "model_config",
              type: "select",
              currentValue: "1m",
              options: [
                { value: "300k", name: "300K" },
                { value: "1m", name: "1M" }
              ]
            }
          ]
        }
      ]
    };
  });

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const connection = app.connect(stream);
await connection.closed;
`);
  return agentPath;
}

describe('cursorPreflightSessionControlsProbeAdapter', () => {
  it('merges cheap Cursor CLI model variants with the active ACP model config surface', async () => {
    const fixture = await createProbeTempDir('happier-cursor-preflight-models');
    try {
      process.env.PATH = '';
      const cursorPath = await writeFakeCursorAgent({
        dir: fixture.dir,
        sdkEntry: resolveAcpSdkEntryFromCwd(process.cwd()),
      });
      delete process.env.HAPPIER_CURSOR_PATH;

      const raw = await cursorPreflightSessionControlsProbeAdapter.probeModelsRaw?.({
        cwd: fixture.dir,
        timeoutMs: 5_000,
        backendTarget: undefined,
        accountSettings: null,
        processEnv: { ...process.env, HAPPIER_CURSOR_PATH: cursorPath },
      });

      const models = Array.isArray(raw) ? raw : [];
      expect(models.find((model) => model.id === 'cursor-exclusive')).toEqual({
        id: 'cursor-exclusive',
        name: 'Cursor Exclusive',
        modelOptions: [{
          id: 'context',
          name: 'Context',
          category: 'model_config',
          type: 'select',
          currentValue: '1m',
          options: [
            { value: '300k', name: '300K' },
            { value: '1m', name: '1M' },
          ],
        }],
      });
      expect(models.find((model) => model.id === 'gpt-5.5')?.modelOptions).toEqual([
        {
          id: 'context',
          name: 'Context',
          category: 'model_config',
          type: 'select',
          currentValue: '272k',
          options: [
            { value: '272k', name: '272K' },
            { value: '1m', name: '1M' },
          ],
        },
        {
          id: 'reasoning_effort',
          name: 'Reasoning effort',
          category: 'thought_level',
          type: 'select',
          currentValue: 'high',
          options: [
            { value: 'none', name: 'None' },
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' },
            { value: 'high', name: 'High' },
            { value: 'extra-high', name: 'XHigh' },
          ],
        },
        {
          id: 'fast',
          name: 'Fast',
          category: 'model_config',
          type: 'select',
          currentValue: 'false',
          options: [
            { value: 'false', name: 'Off' },
            { value: 'true', name: 'Fast' },
          ],
        },
      ]);
      expect(models.find((model) => model.id === 'composer-2.5')?.modelOptions).toEqual([
        {
          id: 'fast',
          name: 'Fast',
          category: 'model_config',
          type: 'select',
          currentValue: 'false',
          options: [
            { value: 'false', name: 'Off' },
            { value: 'true', name: 'Fast' },
          ],
        },
      ]);
      expect(models.find((model) => model.id === 'claude-opus-4-8')?.modelOptions).toEqual([
        {
          id: 'reasoning_effort',
          name: 'Reasoning effort',
          category: 'model_config',
          type: 'select',
          currentValue: 'low',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'max', name: 'Max' },
          ],
        },
        {
          id: 'thinking',
          name: 'Thinking',
          category: 'model_config',
          type: 'boolean',
          currentValue: 'false',
          options: [
            { value: 'false', name: 'Off' },
            { value: 'true', name: 'On' },
          ],
        },
        {
          id: 'fast',
          name: 'Fast',
          category: 'model_config',
          type: 'select',
          currentValue: 'false',
          options: [
            { value: 'false', name: 'Off' },
            { value: 'true', name: 'Fast' },
          ],
        },
      ]);
      expect(models.find((model) => model.id === 'claude-fable-5')?.modelOptions).toEqual([
        {
          id: 'reasoning_effort',
          name: 'Reasoning effort',
          category: 'model_config',
          type: 'select',
          currentValue: 'low',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'max', name: 'Max' },
          ],
        },
        {
          id: 'thinking',
          name: 'Thinking',
          category: 'model_config',
          type: 'boolean',
          currentValue: 'false',
          options: [
            { value: 'false', name: 'Off' },
            { value: 'true', name: 'On' },
          ],
        },
        {
          id: 'fast',
          name: 'Fast',
          category: 'model_config',
          type: 'select',
          currentValue: 'false',
          options: [
            { value: 'false', name: 'Off' },
            { value: 'true', name: 'Fast' },
          ],
        },
      ]);
      expect(models.find((model) => model.id === 'gemini-3.1-pro')?.modelOptions).toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);
});
