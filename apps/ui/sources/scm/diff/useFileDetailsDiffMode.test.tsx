import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { expect, it } from 'vitest';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { useFileDetailsDiffMode } from './useFileDetailsDiffMode';
let current: ReturnType<typeof useFileDetailsDiffMode>;
const modes: string[] = [];
const snapshot: ScmWorkingSnapshot = {
    projectKey: 'p', fetchedAt: 1, repo: { isRepo: true, rootPath: '/repo', backendId: 'git' },
    branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
    hasConflicts: false, entries: [],
    totals: { includedFiles: 1, pendingFiles: 0, untrackedFiles: 0, includedAdded: 1, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
};
const input = { fileKey: 'file', snapshot, backendOverrides: {}, hasIncludedDelta: true, hasPendingDelta: false };
function Harness(props: Parameters<typeof useFileDetailsDiffMode>[0]) { current = useFileDetailsDiffMode(props); modes.push(current[0]); return null; }
it('starts with the resolved mode and preserves explicit choice across unrelated snapshot refresh', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<Harness {...input} />); });
    expect(modes[0]).toBe('included');
    await act(async () => { current[1]('both'); });
    await act(async () => { tree.update(<Harness {...input} snapshot={{ ...snapshot, fetchedAt: 2 }} />); });
    expect(current[0]).toBe('both');
    await act(async () => { tree.update(<Harness {...input} hasIncludedDelta={false} hasPendingDelta />); });
    expect(current[0]).toBe('pending');
    await act(async () => { tree.unmount(); });
});
