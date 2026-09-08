import type { ConnectedServiceId } from './connectedServiceBindings.js';

function hashStringFNV1a32(value: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
}

export function buildRecoveryCreditConsumeIdempotencyKey(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    providerCreditId?: string | null;
    sourceSnapshotFetchedAtMs?: number | null;
}>): string {
    const providerCreditId = typeof input.providerCreditId === 'string' ? input.providerCreditId.trim() : '';
    const snapshotFetchedAtMs = typeof input.sourceSnapshotFetchedAtMs === 'number' && Number.isFinite(input.sourceSnapshotFetchedAtMs)
        ? Math.max(0, Math.trunc(input.sourceSnapshotFetchedAtMs))
        : null;
    const selector = providerCreditId.length > 0
        ? `credit:${providerCreditId}`
        : `aggregate:${snapshotFetchedAtMs ?? 'unknown'}`;
    const key = `connected-service-quota-recovery-credit:v1:${input.serviceId}:${input.profileId}:${selector}`;
    return key.length <= 256
        ? key
        : `connected-service-quota-recovery-credit:v1:${hashStringFNV1a32(key)}:${key.length}`;
}
