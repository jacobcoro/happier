import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { ChangedFilesReviewNavigation } from './ChangedFilesReviewNavigation';
import { createChangedFilesReviewDiffStateSource } from './ChangedFilesReviewDiffStore';
import { installFilesContentCommonModuleMocks } from '../filesContentTestHelpers';

vi.mock('@/sync/store/hooks', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({ useLocalSetting: () => 1 });
});
installFilesContentCommonModuleMocks();

describe('ChangedFilesReviewNavigation', () => {
    it('focuses neighboring files and stops at both ends of the current review scope', async () => {
        const visited: string[] = [];
        function Harness() {
            const [activePath, setActivePath] = React.useState<string | null>(null);
            return <ChangedFilesReviewNavigation diffStateSource={createChangedFilesReviewDiffStateSource()} onFocusLine={() => {}} paths={['a.ts', 'b.ts']} activePath={activePath} onFocusPath={(path) => {
                visited.push(path);
                setActivePath(path);
            }} />;
        }
        const screen = await renderScreen(<Harness />);
        expect(screen.findByTestId('scm-review-previous-file')?.props.disabled).toBe(true);
        await act(async () => { screen.findByTestId('scm-review-next-file')?.props.onPress(); });
        expect(visited).toEqual(['b.ts']);
        expect(screen.findByTestId('scm-review-next-file')?.props.disabled).toBe(true);
        await act(async () => { screen.findByTestId('scm-review-previous-file')?.props.onPress(); });
        expect(visited).toEqual(['b.ts', 'a.ts']);
    });

    it('uses the remaining scope when the previously focused file disappears', async () => {
        const visited: string[] = [];
        const screen = await renderScreen(<ChangedFilesReviewNavigation diffStateSource={createChangedFilesReviewDiffStateSource()} onFocusLine={() => {}} paths={['a.ts', 'c.ts']} activePath="removed.ts" onFocusPath={(path) => visited.push(path)} />);
        await act(async () => { screen.findByTestId('scm-review-next-file')?.props.onPress(); });
        expect(visited).toEqual(['c.ts']);
    });
    it('keeps hunk controls in the fixed navigation and targets only the active file', async () => {
        const source = createChangedFilesReviewDiffStateSource();
        const diff = '@@ -1 +1 @@\n-old\n+new\n@@ -30 +30 @@\n-before\n+after';
        source.setDiffState('a.ts', { status: 'loaded', diff, error: null });
        source.setDiffState('b.ts', { status: 'loaded', diff, error: null });
        const targets: Array<{ filePath: string; lineId: string }> = [];
        const onFocusLine = (target: { filePath: string; lineId: string } | null) => { if (target) targets.push(target); };
        const screen = await renderScreen(<ChangedFilesReviewNavigation paths={['a.ts']} activePath="a.ts" onFocusPath={() => {}} diffStateSource={source} onFocusLine={onFocusLine} />);
        expect(screen.findByTestId('scm-review-next-hunk')).toBeTruthy();
        await act(async () => { screen.findByTestId('scm-review-next-hunk')?.props.onPress(); });
        await act(async () => { screen.findByTestId('scm-review-next-hunk')?.props.onPress(); });
        expect(targets.at(-1)).toEqual({ filePath: 'a.ts', lineId: 'r:4' });
        expect(screen.findByTestId('scm-review-next-hunk')?.props.disabled).toBe(true);
        await act(async () => screen.tree.update(<ChangedFilesReviewNavigation paths={['a.ts', 'b.ts']} activePath="b.ts" onFocusPath={() => {}} diffStateSource={source} onFocusLine={onFocusLine} />));
        await act(async () => { screen.findByTestId('scm-review-next-hunk')?.props.onPress(); });
        expect(targets.at(-1)).toEqual({ filePath: 'b.ts', lineId: 'r:1' });
    });

});
