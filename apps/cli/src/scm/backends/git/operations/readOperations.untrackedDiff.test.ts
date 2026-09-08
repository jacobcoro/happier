import { describe, expect, it, vi } from 'vitest';

import { gitDiffFile } from './readOperations';
import type { ScmBackendContext } from '../../../types';

const runScmCommandSpy = vi.fn();

vi.mock('../../../runtime', async () => {
    const actual = await vi.importActual<typeof import('../../../runtime')>('../../../runtime');
    return {
        ...actual,
        runScmCommand: (input: Parameters<typeof actual.runScmCommand>[0]) => runScmCommandSpy(input),
    };
});

describe('gitDiffFile (untracked)', () => {
    it('falls back to a no-index diff for untracked files when normal diff is empty', async () => {
        runScmCommandSpy.mockReset();
        runScmCommandSpy
            // Normal diff returns empty.
            .mockResolvedValueOnce({ success: true, stdout: '', stderr: '', exitCode: 0 })
            // Detect untracked file.
            .mockResolvedValueOnce({ success: true, stdout: 'Dockerfile\0', stderr: '', exitCode: 0 })
            // no-index diff returns synthetic add diff (git diff exits 1 when differences exist).
            .mockResolvedValueOnce({ success: false, stdout: 'diff --git a/Dockerfile b/Dockerfile\n', stderr: '', exitCode: 1 });

        const context: ScmBackendContext = {
            cwd: '/repo/subdir',
            projectKey: 'machine:/repo',
            detection: { isRepo: true, rootPath: '/repo', mode: '.git' },
        };

        const res = await gitDiffFile({
            context,
            request: { path: 'Dockerfile', area: 'pending' },
        });

        expect(res.success).toBe(true);
        if (!res.success) return;
        expect(res.diff).toContain('diff --git a/Dockerfile b/Dockerfile');

        expect(runScmCommandSpy).toHaveBeenCalledTimes(3);
        expect(runScmCommandSpy.mock.calls[1]?.[0]).toMatchObject({
            bin: 'git',
            cwd: '/repo',
            args: ['ls-files', '--others', '--exclude-standard', '-z', '--', ':(top,literal)Dockerfile'],
        });
        expect(runScmCommandSpy.mock.calls[2]?.[0]).toMatchObject({
            bin: 'git',
            cwd: '/repo',
            args: ['diff', '--no-ext-diff', '--no-index', '--', '/dev/null', 'Dockerfile'],
        });
    });

    it.each(['file\tname.txt', 'file\nname.txt', 'café.txt', 'literal[1].txt'])('reads a literal NUL-delimited untracked path %j', async (path) => {
        runScmCommandSpy.mockReset();
        runScmCommandSpy
            .mockResolvedValueOnce({ success: true, stdout: '', stderr: '', exitCode: 0 })
            .mockResolvedValueOnce({ success: true, stdout: `${path}\0`, stderr: '', exitCode: 0 })
            .mockResolvedValueOnce({ success: false, stdout: '+hello\n', stderr: '', exitCode: 1 });
        expect(await gitDiffFile({
            context: { cwd: '/repo', projectKey: 'machine:/repo', detection: { isRepo: true, rootPath: '/repo', mode: '.git' } },
            request: { path, area: 'pending' },
        })).toEqual({ success: true, diff: '+hello\n' });
    });

    it.each([{ timedOut: true }, { outputLimitExceeded: true }, { exitCode: 2 }])('reports failed untracked diff generation %j', async (failure) => {
        runScmCommandSpy.mockReset();
        runScmCommandSpy
            .mockResolvedValueOnce({ success: true, stdout: '', stderr: '', exitCode: 0 })
            .mockResolvedValueOnce({ success: true, stdout: 'file.txt\0', stderr: '', exitCode: 0 })
            .mockResolvedValueOnce({ success: false, stdout: '', stderr: 'diff failed', exitCode: 1, ...failure });
        expect(await gitDiffFile({
            context: { cwd: '/repo', projectKey: 'machine:/repo', detection: { isRepo: true, rootPath: '/repo', mode: '.git' } },
            request: { path: 'file.txt', area: 'pending' },
        })).toMatchObject({ success: false, error: 'diff failed' });
    });

    it('reports an untracked inspection failure instead of an empty diff', async () => {
        runScmCommandSpy.mockReset();
        runScmCommandSpy
            .mockResolvedValueOnce({ success: true, stdout: '', stderr: '', exitCode: 0 })
            .mockResolvedValueOnce({ success: false, stdout: '', stderr: 'inspection failed', exitCode: 2 });
        expect(await gitDiffFile({
            context: { cwd: '/repo', projectKey: 'machine:/repo', detection: { isRepo: true, rootPath: '/repo', mode: '.git' } },
            request: { path: 'file.txt', area: 'pending' },
        })).toMatchObject({ success: false, error: 'inspection failed' });
    });

    it.each(['pending', 'both'] as const)('reads a tracked %s diff in one command', async (area) => {
        runScmCommandSpy.mockReset();
        runScmCommandSpy.mockResolvedValue({
            success: false,
            stdout: 'diff --git a/a.txt b/a.txt\n',
            stderr: '',
            exitCode: 1,
        });

        const context: ScmBackendContext = {
            cwd: '/repo',
            projectKey: 'machine:/repo',
            detection: { isRepo: true, rootPath: '/repo', mode: '.git' },
        };

        const res = await gitDiffFile({
            context,
            request: { path: 'a.txt', area },
        });

        expect(res.success).toBe(true);
        if (!res.success) return;
        expect(res.diff).toContain('diff --git a/a.txt b/a.txt');

        expect(runScmCommandSpy).toHaveBeenCalledTimes(1);
        const call = runScmCommandSpy.mock.calls[0]?.[0];
        expect(call).toMatchObject({ bin: 'git', cwd: '/repo' });
        expect(call?.args?.slice?.(0, 2)).toEqual(['diff', '--no-ext-diff']);
        expect(String(call?.args?.[call.args.length - 1] ?? '')).toContain('a.txt');
    });
});
