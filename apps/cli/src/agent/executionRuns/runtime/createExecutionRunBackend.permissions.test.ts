import { describe, expect, it, vi } from 'vitest';

import { createExecutionRunPermissionHandler } from './createExecutionRunBackend';

describe('createExecutionRunPermissionHandler', () => {
  it('auto-approves write-like ACP tools for safe-yolo execution runs', async () => {
    const handler = createExecutionRunPermissionHandler({
      backendId: 'copilot',
      permissionMode: 'safe-yolo',
    });

    await expect(handler.handleToolCall('tool-1', 'bash', { command: 'bash -lc "echo hi"' })).resolves.toEqual({
      decision: 'approved_for_session',
    });
  });

  it('denies write-like ACP tools for read-only execution runs', async () => {
    const handler = createExecutionRunPermissionHandler({
      backendId: 'copilot',
      permissionMode: 'read_only',
    });

    await expect(handler.handleToolCall('tool-2', 'bash', { command: 'bash -lc "echo hi"' })).resolves.toEqual({
      decision: 'denied',
    });
  });

  it('routes write-like tools in the admitted default mode through the session permission owner', async () => {
    const interactiveHandler = {
      handleToolCall: vi.fn(async () => ({ decision: 'approved' as const })),
      cancelPendingRequest: vi.fn(() => true),
    };
    const handler = createExecutionRunPermissionHandler({
      backendId: 'codex',
      permissionMode: 'default',
      interactiveHandler,
    });

    await expect(handler.handleToolCall('tool-default', 'bash', { command: 'echo write' })).resolves.toEqual({
      decision: 'approved',
    });
    expect(interactiveHandler.handleToolCall).toHaveBeenCalledWith(
      'tool-default',
      'bash',
      { command: 'echo write' },
      { permissionMode: 'default' },
    );
    expect(handler.cancelPendingRequest?.('tool-default', 'run cancelled')).toBe(true);
    expect(interactiveHandler.cancelPendingRequest).toHaveBeenCalledWith('tool-default', 'run cancelled');
  });

  it('auto-approves read-like ACP tools for read-only execution runs', async () => {
    const handler = createExecutionRunPermissionHandler({
      backendId: 'opencode',
      permissionMode: 'read_only',
    });

    await expect(handler.handleToolCall('tool-3', 'read', { path: 'README.md' })).resolves.toEqual({
      decision: 'approved_for_session',
    });
  });

  it('denies unknown, external MCP, and safe-name substring collisions in read-only execution runs', async () => {
    const handler = createExecutionRunPermissionHandler({
      backendId: 'opencode',
      permissionMode: 'read_only',
    });

    await expect(handler.handleToolCall('tool-unknown', 'mcp__db__drop_table', {})).resolves.toEqual({
      decision: 'denied',
    });
    await expect(handler.handleToolCall('tool-k8s', 'mcp__k8s__apply_manifest', {})).resolves.toEqual({
      decision: 'denied',
    });
    await expect(handler.handleToolCall('tool-substring', 'rethinking_write', {})).resolves.toEqual({
      decision: 'denied',
    });
    await expect(handler.handleToolCall('tool-punctuation', 'r-e-a-d', {})).resolves.toEqual({
      decision: 'denied',
    });
  });

  it('allows only the curated exact git inspection commands in read-only execution runs', async () => {
    const handler = createExecutionRunPermissionHandler({
      backendId: 'claude',
      permissionMode: 'read_only',
    });

    await expect(handler.handleToolCall('git-status', 'Bash', { command: 'git status' })).resolves.toEqual({
      decision: 'approved_for_session',
    });
    await expect(handler.handleToolCall('git-prefix', 'Bash', { command: 'PATH=/tmp/evil git status' })).resolves.toEqual({
      decision: 'denied',
    });
    await expect(handler.handleToolCall('git-args', 'Bash', { command: 'git status --porcelain' })).resolves.toEqual({
      decision: 'denied',
    });
    await expect(handler.handleToolCall('git-compound', 'Bash', { command: 'git status && id' })).resolves.toEqual({
      decision: 'denied',
    });
  });

  it('denies all ACP tools for no_tools execution runs', async () => {
    const handler = createExecutionRunPermissionHandler({
      backendId: 'opencode',
      permissionMode: 'no_tools',
    });

    await expect(handler.handleToolCall('tool-4', 'read', { path: 'README.md' })).resolves.toEqual({
      decision: 'denied',
    });
  });

  it('still auto-approves session_title_set for no_tools execution runs', async () => {
    const handler = createExecutionRunPermissionHandler({
      backendId: 'opencode',
      permissionMode: 'no_tools',
    });

    await expect(handler.handleToolCall('tool-5', 'session_title_set', {})).resolves.toEqual({
      decision: 'approved_for_session',
    });
  });
});
