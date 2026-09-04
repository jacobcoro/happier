import type { SessionOrganizationPin } from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { resolveSessionIdOrPrefix } from '@/session/query/resolveSessionId';
import { fetchSessionPins, setSessionPinById } from '@/session/transport/http/sessionOrganizationHttp';

export type SessionPinStateResult =
  | Readonly<{ ok: true; sessionId: string; pinned: boolean; pinnedAt: number | null }>
  | Readonly<{
      ok: false;
      code: 'session_not_found' | 'session_id_ambiguous' | 'session_lookup_timeout' | 'unsupported' | 'session_pin_limit_exceeded';
      candidates?: string[];
    }>;

function isPinLimitError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'session_pin_limit_exceeded';
}

/**
 * Sets the account-scoped pin for one session, resolving a session id, prefix, or tag first so the
 * pin surface accepts the same targets as every other session control command.
 *
 * Repeating a call is a quiet success: the server upserts a pin and deletes an unpin, so a caller
 * that pins an already-pinned session gets the same result as the first call.
 */
export async function setSessionPinState(params: Readonly<{
  credentials: Credentials;
  idOrPrefix: string;
  pinned: boolean;
}>): Promise<SessionPinStateResult> {
  const resolved = await resolveSessionIdOrPrefix({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
  });
  if (!resolved.ok) {
    return {
      ok: false,
      code: resolved.code,
      ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
    };
  }

  let result;
  try {
    result = await setSessionPinById({
      token: params.credentials.token,
      sessionId: resolved.sessionId,
      pinned: params.pinned,
    });
  } catch (error) {
    if (isPinLimitError(error)) {
      return { ok: false, code: 'session_pin_limit_exceeded' };
    }
    throw error;
  }

  return {
    ok: true,
    sessionId: resolved.sessionId,
    pinned: result.pin !== null,
    pinnedAt: result.pin?.pinnedAt ?? null,
  };
}

export async function listSessionPins(params: Readonly<{ credentials: Credentials }>): Promise<
  Readonly<{ ok: true; pins: readonly SessionOrganizationPin[] }>
> {
  const pins = await fetchSessionPins({ token: params.credentials.token });
  return { ok: true, pins };
}
