import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';

import { installSessionFilesCommonModuleMocks } from './sessionFilesTestHelpers';


// Required for React 18+ act() semantics with react-test-renderer.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const octiconsRenderMock = vi.hoisted(() => vi.fn());

installSessionFilesCommonModuleMocks({
    icons: () => ({
        Octicons: (props: any) => {
            octiconsRenderMock(props.name);
            return React.createElement('Octicons', props);
        },
        Ionicons: 'Ionicons',
    }),
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Platform: {
                select: (value: any) => value?.default ?? null,
            },
        });
    },
});

vi.mock('@/components/sessions/sourceControl/branches/SourceControlBranchMenu', () => ({
    SourceControlBranchMenu: (props: any) => React.createElement('SourceControlBranchMenu', props),
}));

const branchSummaryTheme = createThemeFixture();

describe('SourceControlBranchSummary', () => {
    it('skips rendering counters when parent rerenders with unchanged summary props', async () => {
        const { SourceControlBranchSummary } = await import('./SourceControlBranchSummary');

        const scmStatusFiles = {
            branch: 'feature/refactor',
            upstream: 'origin/feature/refactor',
            ahead: 3,
            behind: 1,
            includedFiles: [],
            pendingFiles: [],
            totalIncluded: 2,
            totalPending: 3,
        };

        function Wrapper(props: Readonly<{ tick: number }>) {
            void props.tick;
            return <SourceControlBranchSummary theme={branchSummaryTheme} scmStatusFiles={scmStatusFiles} variant="rail" />;
        }

        octiconsRenderMock.mockClear();
        const screen = await renderScreen(<Wrapper tick={0} />);
        const initialIconRenderCount = octiconsRenderMock.mock.calls.length;

        await act(async () => {
            screen.tree.update(<Wrapper tick={1} />);
        });

        expect(octiconsRenderMock).toHaveBeenCalledTimes(initialIconRenderCount);
    });

    it('renders the branch menu trigger in rail mode even when write operations are disabled', async () => {
        const { SourceControlBranchSummary } = await import('./SourceControlBranchSummary');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<SourceControlBranchSummary
                    variant="rail"
                    sessionId="s1"
                    scmWriteEnabled={false}
                    scmSnapshot={{
                        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
                        branch: { head: 'dev', upstream: null, ahead: 0, behind: 0, detached: false },
                        capabilities: { readBranches: true, writeRemotePublish: true },
                        totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
                        fetchedAt: Date.now(),
                        projectKey: 'p1',
                        hasConflicts: false,
                        entries: [],
                        stashCount: 0,
                    } as any}
                    theme={branchSummaryTheme}
                    scmStatusFiles={{
                        branch: 'dev',
                        includedFiles: [],
                        pendingFiles: [],
                        totalIncluded: 0,
                        totalPending: 0,
                    }}
                />)).tree;

        const branchMenus = tree!.findAllByType('SourceControlBranchMenu' as any);
        expect(branchMenus).toHaveLength(1);
        expect(branchMenus[0]!.props.writeEnabled).toBe(false);
    });

    it('does not render publish in the rail branch summary', async () => {
        const { SourceControlBranchSummary } = await import('./SourceControlBranchSummary');

        const screen = await renderScreen(<SourceControlBranchSummary
            variant="rail"
            sessionId="s1"
            scmWriteEnabled
            scmSnapshot={{
                repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git', remotes: [{ name: 'origin' }] },
                branch: { head: 'dev', upstream: null, ahead: 0, behind: 0, detached: false },
                capabilities: { readBranches: true, writeRemotePublish: true },
                totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
                fetchedAt: Date.now(),
                projectKey: 'p1',
                hasConflicts: false,
                entries: [],
                stashCount: 0,
            } as any}
            theme={branchSummaryTheme}
            scmStatusFiles={{
                branch: 'dev',
                includedFiles: [],
                pendingFiles: [],
                totalIncluded: 0,
                totalPending: 0,
            }}
        />);

        expect(screen.findAllByTestId('scm-publish-branch')).toHaveLength(0);
    });

    it.each(['index', 'working-copy'] as const)('labels rail counters for the %s change model', async (changeSetModel) => {
        const { SourceControlBranchSummary } = await import('./SourceControlBranchSummary');
        const screen = await renderScreen(<SourceControlBranchSummary
            variant="rail"
            theme={branchSummaryTheme}
            scmStatusFiles={{ branch: 'main', includedFiles: [], pendingFiles: [], totalIncluded: 2, totalPending: 3, changeSetModel }}
        />);
        const included = changeSetModel === 'working-copy' ? 'included' : 'staged';
        const pending = changeSetModel === 'working-copy' ? 'pending' : 'unstaged';
        expect(screen.tree.root.findAll((node) => node.props.accessibilityLabel === `files.branchSummary.${included}: 2`).length).toBeGreaterThan(0);
        expect(screen.tree.root.findAll((node) => node.props.accessibilityLabel === `files.branchSummary.${pending}: 3`).length).toBeGreaterThan(0);
    });

    it('renders branch and staged/unstaged summary', async () => {
        const { SourceControlBranchSummary } = await import('./SourceControlBranchSummary');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<SourceControlBranchSummary
                    theme={branchSummaryTheme}
                    scmStatusFiles={{
                        branch: 'main',
                        includedFiles: [],
                        pendingFiles: [],
                        totalIncluded: 2,
                        totalPending: 3,
                    }}
                />)).tree;

        const texts = tree!.findAllByType('Text' as any).map((node) => node.props.children);
        expect(texts).toContain('main');
        expect(texts).toContain('files.branchSummary.staged');
        expect(texts).toContain('files.branchSummary.unstaged');
    });

    it('renders upstream tracking and ahead/behind counters when available', async () => {
        const { SourceControlBranchSummary } = await import('./SourceControlBranchSummary');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<SourceControlBranchSummary
                    theme={branchSummaryTheme}
                    scmStatusFiles={{
                        branch: 'feature/refactor',
                        upstream: 'origin/feature/refactor',
                        ahead: 3,
                        behind: 1,
                        includedFiles: [],
                        pendingFiles: [],
                        totalIncluded: 0,
                        totalPending: 1,
                    }}
                />)).tree;

        const textContent = tree!
            .root
            .findAllByType('Text' as any)
            .map((node) => {
                const value = node.props.children;
                if (Array.isArray(value)) {
                    return value.join('');
                }
                return String(value);
            });

        expect(textContent.some((text) => text.includes('files.branchSummary.upstreamLabel'))).toBe(true);
        expect(textContent.some((text) => text.includes('files.branchSummary.ahead'))).toBe(true);
        expect(textContent.some((text) => text.includes('files.branchSummary.behind'))).toBe(true);
    });

    it('renders included/pending labels for working-copy change set model', async () => {
        const { SourceControlBranchSummary } = await import('./SourceControlBranchSummary');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<SourceControlBranchSummary
                    theme={branchSummaryTheme}
                    scmStatusFiles={{
                        branch: 'main',
                        changeSetModel: 'working-copy',
                        includedFiles: [],
                        pendingFiles: [],
                        totalIncluded: 0,
                        totalPending: 1,
                    }}
                />)).tree;

        const texts = tree!.findAllByType('Text' as any).map((node) => node.props.children);
        expect(texts).toContain('files.branchSummary.included');
        expect(texts).toContain('files.branchSummary.pending');
        expect(texts).not.toContain('files.branchSummary.staged');
        expect(texts).not.toContain('files.branchSummary.unstaged');
    });
});
