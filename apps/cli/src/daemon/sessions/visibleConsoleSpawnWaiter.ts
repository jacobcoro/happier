import type { SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import type { ChildExit } from './onChildExited';
import type { TrackedSession } from '../types';
import { waitForSessionWebhook } from '../spawn/waitForSessionWebhook';
import { logger } from '@/ui/logger';

export function waitForVisibleConsoleSessionWebhook(params: Readonly<{
  pid: number;
  pollMs: number;
  pidToAwaiter: Map<number, (session: TrackedSession) => void>;
  pidToSpawnResultResolver: Map<number, (result: SpawnSessionResult) => void>;
  pidToSpawnWebhookTimeout: Map<number, ReturnType<typeof setTimeout>>;
  onChildExited: (pid: number, exit: ChildExit) => void | Promise<void>;
}>): Promise<SpawnSessionResult> {
  const { pid, pollMs, pidToAwaiter, pidToSpawnResultResolver, pidToSpawnWebhookTimeout, onChildExited } = params;
  const interval = setInterval(() => {
    try {
      process.kill(pid, 0);
    } catch {
      clearInterval(interval);
      const resolveSpawn = pidToSpawnResultResolver.get(pid);
      if (resolveSpawn) {
        pidToSpawnResultResolver.delete(pid);
        const timeout = pidToSpawnWebhookTimeout.get(pid);
        if (timeout) clearTimeout(timeout);
        pidToSpawnWebhookTimeout.delete(pid);
        pidToAwaiter.delete(pid);
      }
      void (async () => {
        try {
          await onChildExited(pid, { reason: 'process-exited', code: null, signal: null });
        } catch (error) {
          logger.warn('[DAEMON RUN] Failed to complete visible-console exit cleanup; retaining tracked custody', { pid, error });
          resolveSpawn?.({
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
            errorMessage: 'startup_retirement_incomplete:exit_cleanup_incomplete',
          });
          return;
        }
        resolveSpawn?.({
          type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
          errorMessage: `Child process exited before session webhook (pid=${pid})`,
        });
      })();
    }
  }, pollMs);
  if (typeof interval.unref === 'function') {
    interval.unref();
  }

  return waitForSessionWebhook({
    pid,
    pidToAwaiter,
    pidToSpawnResultResolver,
    pidToSpawnWebhookTimeout,
    timeoutErrorMessage: `Session webhook timeout for PID ${pid}`,
    onTimeout: () => {
      clearInterval(interval);
    },
  });
}
