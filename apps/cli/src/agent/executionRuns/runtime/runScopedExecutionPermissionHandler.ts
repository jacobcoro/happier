import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';

export function createRunScopedExecutionPermissionHandler(params: Readonly<{
  runId: string;
  handler: AcpPermissionHandler;
}>): Readonly<{
  handler: AcpPermissionHandler;
  dispose: (reason: string) => void;
}> {
  const runId = String(params.runId ?? '').trim();
  if (!runId) throw new Error('Execution-run permission scope requires a non-blank runId');
  const prefix = `execution-run:${encodeURIComponent(runId)}:`;
  const pendingRequestIds = new Set<string>();
  const scopedRequestId = (requestId: string) => `${prefix}${encodeURIComponent(requestId)}`;

  return {
    handler: {
      async handleToolCall(toolCallId, toolName, input, context) {
        const requestId = scopedRequestId(toolCallId);
        pendingRequestIds.add(requestId);
        try {
          return await params.handler.handleToolCall(requestId, toolName, input, context);
        } finally {
          pendingRequestIds.delete(requestId);
        }
      },
      cancelPendingRequest(requestId, reason) {
        const scopedId = scopedRequestId(requestId);
        const cancelled = params.handler.cancelPendingRequest?.(scopedId, reason) ?? false;
        if (cancelled) pendingRequestIds.delete(scopedId);
        return cancelled;
      },
    },
    dispose(reason) {
      for (const requestId of pendingRequestIds) {
        params.handler.cancelPendingRequest?.(requestId, reason);
      }
      pendingRequestIds.clear();
    },
  };
}
