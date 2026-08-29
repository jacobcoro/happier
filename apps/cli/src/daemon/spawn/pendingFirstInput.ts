import { createHash } from 'node:crypto';
import {
  PendingFirstInputV1Schema,
  type PendingFirstInputV1,
} from '@happier-dev/protocol';

export const HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY = 'HAPPIER_DAEMON_PENDING_FIRST_INPUT';

export type PendingFirstInput = Readonly<PendingFirstInputV1>;

function requireNonBlank(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Pending first input ${field} must not be blank`);
  }
  return value;
}

export function createPendingFirstInput(params: Readonly<{
  text: string;
  spawnNonce: string;
}>): PendingFirstInput {
  const text = requireNonBlank(params.text, 'text');
  const spawnNonce = requireNonBlank(params.spawnNonce, 'spawn nonce').trim();
  const identity = createHash('sha256')
    .update('happier:pending-first-input:v1\0', 'utf8')
    .update(spawnNonce, 'utf8')
    .digest('hex');
  return Object.freeze({ text, localId: `spawn-first:${identity}` });
}

export function serializePendingFirstInputForEnv(input: PendingFirstInput): string {
  return JSON.stringify(PendingFirstInputV1Schema.parse(input));
}

export function readPendingFirstInputFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PendingFirstInput | null {
  const raw = env[HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY];
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Pending first input handoff is malformed');
  }
  const result = PendingFirstInputV1Schema.safeParse(parsed);
  if (!result.success) {
    throw new Error('Pending first input handoff is malformed');
  }
  return Object.freeze(result.data);
}

export function clearPendingFirstInputFromEnv(env: NodeJS.ProcessEnv = process.env): void {
  delete env[HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY];
}

/**
 * Minimal session-client surface a runner needs to hand the daemon-carried first
 * input to the session. Structural so this module stays independent of the API client.
 */
export type PendingFirstInputCommitTarget = Readonly<{
  enqueueSessionUserMessage: (params: Readonly<{
    text: string;
    localId?: string;
    meta?: Record<string, unknown>;
  }>) => Promise<Readonly<{ recoveryBlocked?: Readonly<{ status: string }> }> | void>;
}>;

export type PendingFirstInputCustody = Readonly<{
  /** The carried input, or null when the daemon handed this runner none. */
  input: PendingFirstInput | null;
  /**
   * Commit the carried input exactly once. A failed commit leaves the custody
   * uncommitted so a later session client can retry it.
   */
  commit: (session: PendingFirstInputCommitTarget) => Promise<void>;
}>;

/**
 * Single owner of daemon-carried first-input custody for every backend runner.
 * Backends must not read the handoff env or enqueue the first input themselves;
 * two consumers would either drop the prompt or deliver it twice.
 */
export function createPendingFirstInputCustody(
  env: NodeJS.ProcessEnv = process.env,
): PendingFirstInputCustody {
  const input = readPendingFirstInputFromEnv(env);
  let committed = input === null;
  return {
    input,
    commit: async (session) => {
      if (committed || input === null) return;
      const result = await session.enqueueSessionUserMessage({
        text: input.text,
        localId: input.localId,
        meta: { ...input.meta, source: 'ui', sentFrom: 'cli' },
      });
      if (result?.recoveryBlocked) {
        throw new Error(`Pending first input was blocked: ${result.recoveryBlocked.status}`);
      }
      committed = true;
      clearPendingFirstInputFromEnv(env);
    },
  };
}
