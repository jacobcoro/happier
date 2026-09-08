import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { normalizeRepoRootPathspec, normalizeRepoRootRelativePath } from './runtime';

describe('normalizeRepoRootPathspec', () => {
    it('selects literal filenames and directory children from a nested cwd', () => {
        const cwd = mkdtempSync(join(tmpdir(), 'happier-literal-pathspec-'));
        try {
            execFileSync('git', ['init'], { cwd, stdio: 'pipe' });
            mkdirSync(join(cwd, 'nested'));
            for (const name of ['literal[1].txt', 'literal1.txt', 'dir[1]', 'dir1']) {
                if (name.startsWith('dir')) {
                    mkdirSync(join(cwd, name));
                    writeFileSync(join(cwd, name, 'child.txt'), 'content');
                } else {
                    writeFileSync(join(cwd, name), 'content');
                }
            }
            execFileSync('git', ['add', '.'], { cwd, stdio: 'pipe' });
            for (const [input, expected] of [
                ['literal[1].txt', 'literal[1].txt'],
                ['dir[1]', 'dir[1]/child.txt'],
            ]) {
                const result = normalizeRepoRootPathspec(input);
                expect(result.ok).toBe(true);
                if (!result.ok) throw new Error(result.error);
                const selected = execFileSync('git', ['ls-files', '--full-name', '-z', '--', result.pathspec], {
                    cwd: join(cwd, 'nested'), encoding: 'utf8',
                }).split('\0').filter(Boolean);
                expect(selected).toEqual([expected]);
            }
        } finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });

    it.skipIf(process.platform === 'win32')('preserves leading and trailing filename whitespace', () => {
        const cwd = mkdtempSync(join(tmpdir(), 'happier-whitespace-pathspec-'));
        const filename = ' leading\t\n';
        try {
            execFileSync('git', ['init'], { cwd, stdio: 'pipe' });
            writeFileSync(join(cwd, filename), 'selected');
            writeFileSync(join(cwd, 'leading'), 'unrelated');
            execFileSync('git', ['add', '.'], { cwd, stdio: 'pipe' });
            const result = normalizeRepoRootRelativePath(filename);
            expect(result.ok).toBe(true);
            if (!result.ok) throw new Error(result.error);
            expect(result.relativePath).toBe(filename);
            expect(execFileSync('git', ['ls-files', '-z', '--', result.pathspec], { cwd, encoding: 'utf8' }))
                .toBe(`${filename}\0`);
        } finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });

    it('anchors repo-root-relative paths using git pathspec magic', () => {
        const result = normalizeRepoRootPathspec('src/a.ts');
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.pathspec).toBe(':(top,literal)src/a.ts');
    });

    it('returns the repo-root-relative path for safe filesystem operations', () => {
        const result = normalizeRepoRootRelativePath('src/a.ts');
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.relativePath).toBe('src/a.ts');
        expect(result.pathspec).toBe(':(top,literal)src/a.ts');
    });

    it('rejects pathspec magic injection', () => {
        const result = normalizeRepoRootPathspec(':(exclude)a.ts');
        expect(result.ok).toBe(false);
    });

    it('rejects .. segments', () => {
        const result = normalizeRepoRootPathspec('../a.ts');
        expect(result.ok).toBe(false);
    });
});
