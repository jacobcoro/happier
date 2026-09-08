import { sessionListDirectory } from '@/sync/ops';

import { sortDirectoryEntries } from './sortDirectoryEntries';
import { warmInFlight } from './warmInFlight';

export type RepositoryDirectoryEntry = {
    name: string;
    gitIgnored?: boolean;
    type: 'file' | 'directory';
    sizeBytes?: number;
    modifiedMs?: number;
};

export type ListRepositoryDirectoryEntriesResult =
    | { ok: true; entries: RepositoryDirectoryEntry[]; gitIgnoreAvailable?: boolean }
    | { ok: false; error: string };

const repositoryDirectoryCache = new Map<string, { entries: RepositoryDirectoryEntry[]; gitIgnoreAvailable?: boolean }>();
const repositoryDirectoryWarmInFlight = new Map<string, Promise<ListRepositoryDirectoryEntriesResult>>();

function getCacheKey(sessionId: string, directoryPath: string): string {
    return `${sessionId}:${directoryPath}`;
}

export function getCachedRepositoryDirectoryEntries(input: {
    sessionId: string;
    directoryPath: string;
}): RepositoryDirectoryEntry[] | null {
    const key = getCacheKey(input.sessionId, input.directoryPath);
    const cached = repositoryDirectoryCache.get(key);
    return cached ? cached.entries.slice() : null;
}

export function getCachedRepositoryGitIgnoreAvailable(input: { sessionId: string; directoryPath: string }): boolean | undefined {
    return repositoryDirectoryCache.get(getCacheKey(input.sessionId, input.directoryPath))?.gitIgnoreAvailable;
}

export function setCachedRepositoryDirectoryEntries(input: {
    sessionId: string;
    directoryPath: string;
    entries: RepositoryDirectoryEntry[];
    gitIgnoreAvailable?: boolean;
}): void {
    const key = getCacheKey(input.sessionId, input.directoryPath);
    repositoryDirectoryCache.set(key, { entries: input.entries.slice(), gitIgnoreAvailable: input.gitIgnoreAvailable });
}

export function clearCachedRepositoryDirectoryEntries(input: {
    sessionId: string;
    directoryPath?: string | null;
}): void {
    const sessionPrefix = `${input.sessionId}:`;
    const directoryPath = typeof input.directoryPath === 'string' ? input.directoryPath : null;
    if (directoryPath != null) {
        const key = getCacheKey(input.sessionId, directoryPath);
        repositoryDirectoryCache.delete(key);
        repositoryDirectoryWarmInFlight.delete(key);
        return;
    }

    for (const key of repositoryDirectoryCache.keys()) {
        if (key.startsWith(sessionPrefix)) {
            repositoryDirectoryCache.delete(key);
        }
    }
    for (const key of repositoryDirectoryWarmInFlight.keys()) {
        if (key.startsWith(sessionPrefix)) {
            repositoryDirectoryWarmInFlight.delete(key);
        }
    }
}

export async function warmRepositoryDirectoryCache(input: {
    sessionId: string;
    directoryPath: string;
}): Promise<ListRepositoryDirectoryEntriesResult> {
    const cached = getCachedRepositoryDirectoryEntries(input);
    if (cached) {
        return { ok: true, entries: cached, gitIgnoreAvailable: getCachedRepositoryGitIgnoreAvailable(input) };
    }

    const key = getCacheKey(input.sessionId, input.directoryPath);
    return await warmInFlight(repositoryDirectoryWarmInFlight, key, async () => await listRepositoryDirectoryEntries(input));
}

type SessionListDirectoryLikeResponse = {
    success?: boolean;
    gitIgnoreAvailable?: boolean;
    error?: string | null;
    entries?: Array<{
        name?: string;
        gitIgnored?: boolean;
        type?: 'file' | 'directory' | 'other';
        size?: number;
        modified?: number;
    }>;
};

export function sortRepositoryDirectoryEntries(entries: RepositoryDirectoryEntry[]): RepositoryDirectoryEntry[] {
    return sortDirectoryEntries(entries);
}

export async function listRepositoryDirectoryEntries(input: {
    sessionId: string;
    directoryPath: string;
}): Promise<ListRepositoryDirectoryEntriesResult> {
    const response = await sessionListDirectory(input.sessionId, input.directoryPath, { includeGitIgnore: true }) as unknown as SessionListDirectoryLikeResponse | null;
    if (!response) {
        return { ok: false, error: 'unknown_error' };
    }
    if (response.success !== true) {
        const err = typeof response.error === 'string' ? response.error.trim() : '';
        return { ok: false, error: err || 'unknown_error' };
    }
    if (!Array.isArray(response.entries)) {
        return { ok: false, error: 'unknown_error' };
    }

    const entries: RepositoryDirectoryEntry[] = [];
    for (const entry of response.entries) {
        if (!entry || typeof entry.name !== 'string') continue;
        const raw = entry.name.trim();
        if (!raw) continue;
        if (entry.type !== 'file' && entry.type !== 'directory') continue;
        const sizeBytes = typeof entry.size === 'number' && Number.isFinite(entry.size) && entry.size >= 0
            ? Math.floor(entry.size)
            : undefined;
        const modifiedMs = typeof entry.modified === 'number' && Number.isFinite(entry.modified) && entry.modified >= 0
            ? Math.floor(entry.modified)
            : undefined;
        entries.push({ name: raw, type: entry.type, sizeBytes, modifiedMs,
            ...(response.gitIgnoreAvailable === true && typeof entry.gitIgnored === 'boolean' ? { gitIgnored: entry.gitIgnored } : {}),
        });
    }

    const sorted = sortRepositoryDirectoryEntries(entries);
    setCachedRepositoryDirectoryEntries({
        sessionId: input.sessionId,
        directoryPath: input.directoryPath,
        entries: sorted,
        gitIgnoreAvailable: response.gitIgnoreAvailable === true,
    });
    return { ok: true, entries: sorted, gitIgnoreAvailable: response.gitIgnoreAvailable === true };
}
