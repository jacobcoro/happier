export type PendingTerminalPairing = Readonly<{
    secretB64Url: string;
    createdAtMs: number;
    expiresAtMs: number;
}>;

export type PendingTerminalConnect = Readonly<{
    publicKeyB64Url: string;
    serverUrl: string;
    pairing?: PendingTerminalPairing;
}>;

export type PendingTerminalConnectRecord = Readonly<{
    publicKeyB64Url: string;
    serverUrl: string;
    createdAtMs: number;
    pairing?: PendingTerminalPairing;
}>;

export type PreAuthPendingTerminalConnectRecord = Readonly<{
    state: 'pre_auth';
    record: PendingTerminalConnectRecord;
    claimedScope?: Readonly<{
        serverId: string;
        accountId: string;
    }>;
}>;

const DEFAULT_TTL_MS = 10 * 60 * 1000;

function readTtlFromEnv(): number {
    const raw = String(process.env.EXPO_PUBLIC_PENDING_TERMINAL_CONNECT_TTL_MS ?? '').trim();
    if (!raw) return DEFAULT_TTL_MS;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_TTL_MS;
    return Math.floor(value);
}

const ttlMs = readTtlFromEnv();

function normalizePairing(value: unknown): PendingTerminalPairing | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    const secretB64Url = String(record.secretB64Url ?? '').trim();
    const createdAtMs = Number(record.createdAtMs);
    const expiresAtMs = Number(record.expiresAtMs);
    if (
        !secretB64Url
        || !Number.isSafeInteger(createdAtMs)
        || !Number.isSafeInteger(expiresAtMs)
        || createdAtMs < 0
        || expiresAtMs <= createdAtMs
    ) {
        return undefined;
    }
    return { secretB64Url, createdAtMs, expiresAtMs };
}

export function toRecord(value: PendingTerminalConnect, createdAtMs = Date.now()): PendingTerminalConnectRecord | null {
    const publicKeyB64Url = String(value?.publicKeyB64Url ?? '').trim();
    const serverUrl = String(value?.serverUrl ?? '').trim();
    if (!publicKeyB64Url || !serverUrl) return null;
    const pairing = normalizePairing(value.pairing);
    return {
        publicKeyB64Url,
        serverUrl,
        createdAtMs,
        ...(pairing ? { pairing } : {}),
    };
}

export function parseRecord(value: unknown): PendingTerminalConnectRecord | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const publicKeyB64Url = String(record.publicKeyB64Url ?? '').trim();
    const serverUrl = String(record.serverUrl ?? '').trim();
    const createdAtMs = Number(record.createdAtMs ?? 0);
    if (!publicKeyB64Url || !serverUrl || !Number.isFinite(createdAtMs) || createdAtMs <= 0) return null;
    if (Date.now() - createdAtMs > ttlMs) return null;
    const pairing = normalizePairing(record.pairing);
    if (pairing && Date.now() >= pairing.expiresAtMs) return null;
    return {
        publicKeyB64Url,
        serverUrl,
        createdAtMs,
        ...(pairing ? { pairing } : {}),
    };
}

export function fromRecord(value: unknown): PendingTerminalConnect | null {
    const record = parseRecord(value);
    if (!record) return null;
    return {
        publicKeyB64Url: record.publicKeyB64Url,
        serverUrl: record.serverUrl,
        ...(record.pairing ? { pairing: record.pairing } : {}),
    };
}

export function parsePreAuthRecord(value: unknown): PreAuthPendingTerminalConnectRecord | null {
    if (!value || typeof value !== 'object') return null;
    const envelope = value as Record<string, unknown>;
    if (envelope.state !== 'pre_auth') return null;
    const record = parseRecord(envelope.record);
    if (!record) return null;
    const claimed = envelope.claimedScope;
    if (claimed === undefined) return { state: 'pre_auth', record };
    if (!claimed || typeof claimed !== 'object') return null;
    const claimedRecord = claimed as Record<string, unknown>;
    const serverId = String(claimedRecord.serverId ?? '').trim();
    const accountId = String(claimedRecord.accountId ?? '').trim();
    if (!serverId || !accountId) return null;
    return { state: 'pre_auth', record, claimedScope: { serverId, accountId } };
}

export function recordsRepresentSameRequest(
    a: PendingTerminalConnectRecord,
    b: PendingTerminalConnectRecord,
): boolean {
    return a.publicKeyB64Url === b.publicKeyB64Url
        && a.pairing?.secretB64Url === b.pairing?.secretB64Url
        && a.pairing?.createdAtMs === b.pairing?.createdAtMs
        && a.pairing?.expiresAtMs === b.pairing?.expiresAtMs;
}
