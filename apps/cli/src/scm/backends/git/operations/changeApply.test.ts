import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitChangeExclude, gitChangeInclude } from './changeApply';

describe('Git literal change selection', () => {
    it('stages and unstages only the selected literal filename', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'happier-change-literal-'));
        const git = (args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
        try {
            git(['init']);
            git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'base']);
            writeFileSync(join(cwd, 'literal[1].txt'), 'selected');
            writeFileSync(join(cwd, 'literal1.txt'), 'unrelated');
            const input = {
                context: { cwd, projectKey: 'test', detection: { isRepo: true, rootPath: cwd, mode: '.git' as const } },
                request: { paths: ['literal[1].txt'] },
            };
            expect((await gitChangeInclude(input)).success).toBe(true);
            expect(git(['diff', '--cached', '--name-only', '-z'])).toBe('literal[1].txt\0');
            git(['add', 'literal1.txt']);
            expect((await gitChangeExclude(input)).success).toBe(true);
            expect(git(['diff', '--cached', '--name-only', '-z'])).toBe('literal1.txt\0');
        } finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
});
