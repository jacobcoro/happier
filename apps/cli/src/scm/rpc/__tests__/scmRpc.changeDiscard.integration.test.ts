import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createTestRpcManager, runGit } from './testRpcHarness';

describe('scm rpc change discard (git)', () => {
    function createGitWorkspace(): string {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-scm-discard-git-'));
        runGit(workspace, ['init']);
        runGit(workspace, ['config', 'user.email', 'test@example.com']);
        runGit(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        runGit(workspace, ['add', 'a.txt']);
        runGit(workspace, ['commit', '-m', 'init']);
        return workspace;
    }


    it.each([false, true])('truthfully discards a staged addition with index lock=%s', async (locked) => {
        const workspace = createGitWorkspace();
        writeFileSync(join(workspace, 'new.txt'), 'new\n');
        runGit(workspace, ['add', 'new.txt']);
        const indexBefore = readFileSync(join(workspace, '.git', 'index'));
        if (locked) writeFileSync(join(workspace, '.git', 'index.lock'), '');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<{ success: boolean }, { cwd: string; entries: Array<{ path: string; kind: string }> }>(
            RPC_METHODS.SCM_CHANGE_DISCARD,
            { cwd: '.', entries: [{ path: 'new.txt', kind: 'added' }] },
        );
        expect(response.success).toBe(!locked);
        expect(existsSync(join(workspace, 'new.txt'))).toBe(locked);
        if (locked) expect(readFileSync(join(workspace, '.git', 'index'))).toEqual(indexBefore);
        else expect(runGit(workspace, ['status', '--porcelain'])).toBe('');
    });


    it('discards only the requested bracket filename', async () => {
        const workspace = createGitWorkspace();
        writeFileSync(join(workspace, 'literal[1].txt'), 'chosen\n');
        writeFileSync(join(workspace, 'literal1.txt'), 'keep\n');
        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<{ success: boolean }, { entries: Array<{ path: string; kind: string }> }>(
            RPC_METHODS.SCM_CHANGE_DISCARD, { entries: [{ path: 'literal[1].txt', kind: 'untracked' }] },
        );
        expect(response.success).toBe(true);
        expect(existsSync(join(workspace, 'literal[1].txt'))).toBe(false);
        expect(readFileSync(join(workspace, 'literal1.txt'), 'utf8')).toBe('keep\n');
    });

    it('discards pending modifications to a tracked file', async () => {
        const workspace = createGitWorkspace();
        writeFileSync(join(workspace, 'a.txt'), 'changed\n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const discard = await call<any, { cwd?: string; entries: Array<{ path: string; kind: string }> }>(
            RPC_METHODS.SCM_CHANGE_DISCARD,
            {
                cwd: '.',
                entries: [{ path: 'a.txt', kind: 'modified' }],
            }
        );

        expect(discard.success).toBe(true);
        expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('base\n');
    });

    it('removes untracked files when discarded', async () => {
        const workspace = createGitWorkspace();
        writeFileSync(join(workspace, 'b.txt'), 'tmp\n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const discard = await call<any, { cwd?: string; entries: Array<{ path: string; kind: string }> }>(
            RPC_METHODS.SCM_CHANGE_DISCARD,
            {
                cwd: '.',
                entries: [{ path: 'b.txt', kind: 'untracked' }],
            }
        );

        expect(discard.success).toBe(true);
        const status = await call<any, { cwd?: string }>(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: '.' });
        expect(status.success).toBe(true);
        expect((status.snapshot.entries as Array<{ path: string }>).some((e) => e.path === 'b.txt')).toBe(false);
    });
});

