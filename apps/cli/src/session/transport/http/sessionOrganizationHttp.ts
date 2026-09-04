import axios from 'axios';
import {
  type SessionOrganizationPin,
  SessionOrganizationSnapshotResponseSchema,
  SetSessionPinResponseSchema,
} from '@happier-dev/protocol';

import { createHttpStatusError, isAuthenticationStatus } from '@/api/client/httpStatusError';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl } from './serverHttpBaseUrl';

function throwSessionNotFound(): never {
  const error = new Error('Session not found');
  (error as { code?: string }).code = 'session_not_found';
  throw error;
}

function throwPinLimitExceeded(): never {
  const error = new Error('Pinned session limit reached');
  (error as { code?: string }).code = 'session_pin_limit_exceeded';
  throw error;
}

/**
 * Writes the account-scoped pin for one session.
 *
 * The server owns idempotency: a pin write is an upsert on `(accountId, sessionId)` and an unpin
 * write is a delete-if-present, so repeating either call is a quiet success rather than a unique
 * constraint failure surfaced at the caller.
 */
export async function setSessionPinById(params: Readonly<{
  token: string;
  sessionId: string;
  pinned: boolean;
}>): Promise<Readonly<{ pin: SessionOrganizationPin | null }>> {
  const serverUrl = resolveServerHttpBaseUrl();
  const encodedSessionId = encodeURIComponent(params.sessionId);
  const response = await axios.put(
    `${serverUrl}/v2/session-organization/pins/${encodedSessionId}`,
    { pinned: params.pinned },
    {
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      timeout: configuration.sessionControlHttpTimeoutMs,
      validateStatus: () => true,
    },
  );

  if (isAuthenticationStatus(response.status)) {
    throw createHttpStatusError(response.status, `Unauthorized (${response.status})`, 'not_authenticated');
  }
  if (response.status === 404) throwSessionNotFound();
  if (response.status === 409) throwPinLimitExceeded();
  if (response.status !== 200) {
    throw createHttpStatusError(
      response.status,
      `Unexpected status from /v2/session-organization/pins/${params.sessionId}: ${response.status}`,
    );
  }

  const parsed = SetSessionPinResponseSchema.safeParse(response.data);
  if (!parsed.success) {
    throw new Error(`Unexpected /v2/session-organization/pins/${params.sessionId} response shape`);
  }
  return { pin: parsed.data.pin };
}

/**
 * Reads the account's pinned sessions straight from the server so a caller can verify a pin
 * instead of trusting the write response.
 */
export async function fetchSessionPins(params: Readonly<{ token: string }>): Promise<readonly SessionOrganizationPin[]> {
  const serverUrl = resolveServerHttpBaseUrl();
  const response = await axios.get(`${serverUrl}/v2/session-organization`, {
    params: { includeFolders: false, includeTags: false, includeLabels: false },
    headers: {
      Authorization: `Bearer ${params.token}`,
    },
    timeout: configuration.sessionControlHttpTimeoutMs,
    validateStatus: () => true,
  });

  if (isAuthenticationStatus(response.status)) {
    throw createHttpStatusError(response.status, `Unauthorized (${response.status})`, 'not_authenticated');
  }
  if (response.status !== 200) {
    throw createHttpStatusError(
      response.status,
      `Unexpected status from /v2/session-organization: ${response.status}`,
    );
  }

  const parsed = SessionOrganizationSnapshotResponseSchema.safeParse(response.data);
  if (!parsed.success) {
    throw new Error('Unexpected /v2/session-organization response shape');
  }
  return parsed.data.snapshot.pins;
}
