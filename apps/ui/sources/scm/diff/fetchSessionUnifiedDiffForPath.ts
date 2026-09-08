import { scmDiffCache } from '@/scm/diffCache/scmDiffCacheSingleton';
import { resolveSessionScmDiffCacheScope } from '@/scm/diffCache/scmDiffCacheKey';
import { sessionReadFile, sessionScmDiffFile } from '@/sync/ops';
import { decodeUtf8Base64 } from '@/scm/diff/fallbackUnifiedDiff';
import { fetchUnifiedDiffForPath, type UnifiedDiffInput } from './fetchUnifiedDiffForPath';

type Input = Omit<UnifiedDiffInput, 'cacheKey' | 'loadDiff' | 'readFileForFallback'> & Readonly<{
    sessionId: string;
    snapshotSignature?: string | null;
    readFileForFallback?: () => Promise<string | null>;
}>;

export function fetchSessionUnifiedDiffForPath(input: Input): ReturnType<typeof fetchUnifiedDiffForPath> {
    return fetchUnifiedDiffForPath({
        ...input,
        cacheKey: input.snapshotSignature ? { sessionId: resolveSessionScmDiffCacheScope(input.sessionId), snapshotSignature: input.snapshotSignature, diffArea: input.diffArea, path: input.path } : null,
        loadDiff: () => sessionScmDiffFile(input.sessionId, { path: input.path, area: input.diffArea }),
        readFileForFallback: input.readFileForFallback ?? (async () => {
            const response = await sessionReadFile(input.sessionId, input.path);
            return response.success && typeof response.content === 'string' ? decodeUtf8Base64(response.content) : null;
        }),
    });
}

export function invalidateSessionUnifiedDiffPath(input: Readonly<{ sessionId: string; path: string }>): void {
    scmDiffCache.invalidatePaths({ sessionId: resolveSessionScmDiffCacheScope(input.sessionId), paths: new Set([input.path]) });
}
