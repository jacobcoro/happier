import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readUntrackedFileStats } from './readUntrackedFileStats';

describe('readUntrackedFileStats', () => {
    const roots: string[] = [];
    afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

    it.skipIf(process.platform === 'win32')('counts symlink content without following existing or dangling targets', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scm-untracked-links-'));
        roots.push(root);
        await writeFile(join(root, 'target'), 'line\n'.repeat(20));
        await symlink('target', join(root, 'link'));
        await symlink('absent', join(root, 'dangling'));
        expect(await readUntrackedFileStats(root, ['link', 'dangling'])).toEqual({
            link: { pendingAdded: 1, isBinary: false },
            dangling: { pendingAdded: 1, isBinary: false },
        });
    });

    it('measures complete text lines and NUL evidence, leaving oversized files unmeasured', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scm-untracked-stats-'));
        roots.push(root);
        const files = { empty: '', terminated: 'hello\n', unterminated: 'hello', multiline: 'hello\nworld\n', binary: 'hello\0world', oversized: 'x'.repeat(5_000_001) };
        await Promise.all(Object.entries(files).map(([name, content]) => writeFile(join(root, name), content)));
        const result = await readUntrackedFileStats(root, Object.keys(files));
        expect(result).toEqual({
            empty: { pendingAdded: 0, isBinary: false },
            terminated: { pendingAdded: 1, isBinary: false },
            unterminated: { pendingAdded: 1, isBinary: false },
            multiline: { pendingAdded: 2, isBinary: false },
            binary: { pendingAdded: 0, isBinary: true },
        });
    });
});
