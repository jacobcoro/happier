import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { sessionListDirectory } from '@/sync/ops';
import { useRepositoryTreeBrowser } from './useRepositoryTreeBrowser';

// Remote filesystem boundary: the directory parser, cache and lazy tree remain real.
vi.mock('@/sync/ops', () => ({ sessionListDirectory: vi.fn() }));

describe('Project tree', () => {
    it('switches Project/All files locally and preserves revealed ignored targets', async () => {
        vi.mocked(sessionListDirectory).mockImplementation(async (_session, path) => ({
            success: true,
            gitIgnoreAvailable: true,
            entries: path ? [] : [
                { name: 'ignored.log', type: 'file', gitIgnored: true },
                { name: '.env.example', type: 'file', gitIgnored: false },
            ],
        }));
        let api: ReturnType<typeof useRepositoryTreeBrowser> | undefined;
        function Test({ mode, preservedPaths = [] }: { mode: 'project' | 'all'; preservedPaths?: string[] }) {
            api = useRepositoryTreeBrowser({ sessionId: 'visibility-live', enabled: true, visibilityMode: mode, preservedPaths });
            return null;
        }
        const screen = await renderScreen(<Test mode="project" />);
        await act(async () => {});
        expect(api?.nodes.map(n => n.path)).toEqual(['.env.example']);
        expect(api?.gitIgnoreAvailable).toBe(true);
        vi.mocked(sessionListDirectory).mockClear();
        await act(async () => { screen.update(<Test mode="all" />); });
        expect(api?.nodes.map(n => n.path)).toEqual(['.env.example', 'ignored.log']);
        await act(async () => { screen.update(<Test mode="project" preservedPaths={['ignored.log']} />); });
        expect(api?.nodes.map(n => n.path)).toEqual(['.env.example', 'ignored.log']);
        expect(sessionListDirectory).not.toHaveBeenCalled();
    });
});
