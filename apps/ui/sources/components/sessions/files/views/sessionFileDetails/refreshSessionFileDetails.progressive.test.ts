import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installSessionFileDetailsCommonModuleMocks } from './sessionFileDetailsTestHelpers';
import { refreshSessionFileDetails } from './refreshSessionFileDetails';

installSessionFileDetailsCommonModuleMocks();
const transport = vi.hoisted(() => ({ diff: vi.fn(), stat: vi.fn(), read: vi.fn() }));
// Remote filesystem/SCM RPCs are the boundary; normalization and preview policy stay real.
vi.mock('@/sync/ops', () => ({ sessionScmDiffFile: transport.diff, sessionStatFile: transport.stat, sessionReadFile: transport.read }));
vi.mock('@/config', () => ({ config: { filesPreviewMaxBytes: 1000000 } }));
vi.mock('@/platform/digest', () => ({ digest: async () => new Uint8Array(32) }));
const patch = 'diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n';
const input = { sessionId: 's', sessionPath: '/repo', sessionsReady: true, filePath: 'file.txt', diffMode: 'pending' as const, fileEntryKind: 'modified' as const };

describe('file details independent acquisition', () => {
    beforeEach(() => {
        transport.diff.mockReset().mockResolvedValue({ success: true, diff: patch });
        transport.stat.mockReset().mockResolvedValue({ success: true, exists: true, sizeBytes: 4 });
        transport.read.mockReset().mockResolvedValue({ success: true, content: 'bmV3Cg==' });
    });
    it('publishes a useful patch while the bounded file read is still pending', async () => {
        let finishRead!: (value: { success: true; content: string }) => void;
        transport.read.mockReturnValue(new Promise((resolve) => { finishRead = resolve; }));
        const onDiffContent = vi.fn();
        const pending = refreshSessionFileDetails({ ...input, onDiffContent });
        await vi.waitFor(() => expect(onDiffContent).toHaveBeenCalledWith(patch));
        expect(transport.read).toHaveBeenCalled();
        finishRead({ success: true, content: 'bmV3Cg==' });
        expect(await pending).toMatchObject({ status: 'ready', diffContent: patch, fileContent: { content: 'new\n' } });
    });
    it('skips Git for a clean file', async () => {
        transport.diff.mockResolvedValue({ success: true, diff: '' });
        const result = await refreshSessionFileDetails({ ...input, includeDiff: false });
        expect(result).toMatchObject({ status: 'ready', fileContent: { content: 'new\n' } });
        expect(transport.diff).not.toHaveBeenCalled();
    });
    it('keeps a deleted-file patch when reading the removed file fails', async () => {
        transport.read.mockResolvedValue({ success: false, error: 'ENOENT' });
        const result = await refreshSessionFileDetails({ ...input, fileEntryKind: 'deleted' });
        expect(result).toMatchObject({ status: 'ready', diffContent: patch, error: 'ENOENT', fileWriteSupported: false });
    });
    it('retains a small patch when the full file exceeds the preview bound', async () => {
        transport.stat.mockResolvedValue({ success: true, exists: true, sizeBytes: 2000000 });
        const result = await refreshSessionFileDetails(input);
        expect(result).toMatchObject({ status: 'ready', diffContent: patch, fileContent: null, error: 'files.fileTooLargeToPreview' });
        expect(transport.read).not.toHaveBeenCalled();
    });
    it('does not request text or Git for a known binary preview', async () => {
        const result = await refreshSessionFileDetails({ ...input, filePath: 'image.png' });
        expect(result).toMatchObject({ status: 'ready', fileContent: { isBinary: true, binaryMime: 'image/png' } });
        expect(transport.diff).not.toHaveBeenCalled();
        expect(transport.read).not.toHaveBeenCalled();
    });

    it('does not download editor text for a diff-only request with a useful patch', async () => {
        const result = await refreshSessionFileDetails({ ...input, includeFile: false });
        expect(result).toMatchObject({ status: 'ready', diffContent: patch, fileContent: null });
        expect(transport.stat).not.toHaveBeenCalled();
        expect(transport.read).not.toHaveBeenCalled();
    });
    it('still reads bounded text for an added-file fallback on a diff-only request', async () => {
        transport.diff.mockResolvedValue({ success: true, diff: '' });
        const result = await refreshSessionFileDetails({ ...input, fileEntryKind: 'untracked', includeFile: false });
        expect(result).toMatchObject({ status: 'ready', diffContent: expect.stringContaining('+new') });
        expect(transport.read).toHaveBeenCalledTimes(1);
    });

    it('invalidates a cached patch when refreshing the file without requesting Git', async () => {
        const cachedInput = { ...input, snapshotSignature: 'file-save-before-status' };
        await refreshSessionFileDetails({ ...cachedInput, includeFile: false });
        const changedPatch = patch.replace('+new', '+updated');
        transport.diff.mockResolvedValue({ success: true, diff: changedPatch });
        await refreshSessionFileDetails({ ...cachedInput, includeDiff: false, forceRefresh: true });
        const result = await refreshSessionFileDetails({ ...cachedInput, includeFile: false });
        expect(result).toMatchObject({ diffContent: changedPatch });
    });

    it('does not invent pending additions for a file already in the index', async () => {
        transport.diff.mockResolvedValue({ success: true, diff: '' });
        const result = await refreshSessionFileDetails({ ...input, fileEntryKind: 'added', fileHasIncludedDelta: true });
        expect(result).toMatchObject({ diffContent: null, fileContent: { content: 'new\n' } });
    });

    it('retains the added-file fallback for a working-copy addition without index changes', async () => {
        transport.diff.mockResolvedValue({ success: true, diff: '' });
        const result = await refreshSessionFileDetails({ ...input, fileEntryKind: 'added', fileHasIncludedDelta: false });
        expect(result).toMatchObject({ diffContent: expect.stringContaining('+new') });
    });

});
