import { describe, expect, it } from 'vitest';
import { ScmDiffCache } from '../diffCache/scmDiffCache';
import { fetchUnifiedDiffForPath, type UnifiedDiffInput } from './fetchUnifiedDiffForPath';

const patch = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-before\n+after\n';

function input(): UnifiedDiffInput {
    return {
        path: 'a.ts', diffArea: 'pending', file: { status: 'modified' },
        normalizeError: String, fallbackError: 'failed',
        cacheKey: { sessionId: 's', snapshotSignature: 'fresh', diffArea: 'pending', path: 'a.ts' },
        diffCache: new ScmDiffCache({ maxEntries: 10, maxTotalBytes: 10_000, now: () => 1 }),
        loadDiff: async () => ({ success: true, diff: patch }),
        readFileForFallback: async () => { throw new Error('ordinary diff must not read file'); },
    };
}

describe('fetchUnifiedDiffForPath', () => {
    it('shares the normalized patch between a pending open and a later cache hit', async () => {
        let finish!: (value: { success: true; diff: string }) => void;
        let requests = 0;
        const request = { ...input(), loadDiff: () => { requests++; return new Promise<{ success: true; diff: string }>((resolve) => { finish = resolve; }); } };
        const first = fetchUnifiedDiffForPath(request);
        const second = fetchUnifiedDiffForPath(request);
        expect(requests).toBe(1);
        finish({ success: true, diff: patch + patch.replaceAll('a.ts', 'b.ts') });
        expect(await first).toEqual({ success: true, diff: patch.trimEnd() });
        expect(await second).toEqual(await fetchUnifiedDiffForPath(request));
        expect(requests).toBe(1);
    });

    it('explicit refresh replaces the cached patch even before the snapshot advances', async () => {
        let version = 0;
        const request = { ...input(), loadDiff: async () => ({ success: true, diff: patch.replace('after', `after${++version}`) }) };
        const first = await fetchUnifiedDiffForPath(request);
        const fresh = await fetchUnifiedDiffForPath({ ...request, forceRefresh: true });
        expect(fresh).not.toEqual(first);
        expect(await fetchUnifiedDiffForPath(request)).toEqual(fresh);
        expect(version).toBe(2);
    });

    it.each(['untracked', 'added'] as const)('preserves an empty included diff for a %s file without reading working-tree content', async (status) => {
        let reads = 0;
        const request: UnifiedDiffInput = {
            ...input(), diffArea: 'included', cacheKey: null, file: { status },
            loadDiff: async () => ({ success: true, diff: '' }),
            readFileForFallback: async () => { reads++; return 'working-tree text\n'; },
        };
        expect(await fetchUnifiedDiffForPath(request)).toEqual({ success: true, diff: '' });
        expect(reads).toBe(0);
    });

    it.each([true, false, undefined])('uses added-file fallback only with known absent included content (%s)', async (hasIncludedDelta) => {
        let reads = 0;
        const request = {
            ...input(), cacheKey: null, file: { status: 'added' as const, hasIncludedDelta },
            loadDiff: async () => ({ success: true, diff: '' }),
            readFileForFallback: async () => { reads++; return 'working-tree text\n'; },
        };
        const result = await fetchUnifiedDiffForPath(request);
        if (hasIncludedDelta === false) {
            expect(result.success && result.diff).toContain('+working-tree text');
            expect(reads).toBe(1);
        } else {
            expect(result).toEqual({ success: true, diff: '' });
            expect(reads).toBe(0);
        }
    });

    it('uses the callers shared content for new-file fallback without caching a bounded read', async () => {
        let reads = 0;
        const fileTask = (async () => { reads++; return 'new text\n'; })();
        const request: UnifiedDiffInput = { ...input(), file: { status: 'untracked' }, loadDiff: async () => ({ success: true, diff: '' }), readFileForFallback: () => fileTask };
        expect(await fetchUnifiedDiffForPath({ ...request, readFileForFallback: async () => null })).toEqual({ success: true, diff: '' });
        const [first, second] = await Promise.all([fetchUnifiedDiffForPath(request), fetchUnifiedDiffForPath(request)]);
        expect(first).toEqual(second);
        expect(first.success && first.diff).toContain('+new text');
        expect(reads).toBe(1);
    });
});
