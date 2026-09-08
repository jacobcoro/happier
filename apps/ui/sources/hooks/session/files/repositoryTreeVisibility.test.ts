import { describe, expect, it } from 'vitest';
import { projectRepositoryTreeNodes } from './repositoryTreeVisibility';

describe('Project tree visibility', () => {
    it('hides classified ignores while preserving useful dotfiles, changed and revealed paths and ancestors', () => {
        const nodes = [
            { path: '.git', type: 'directory', depth: 0 },
            { path: '.git/config', type: 'file', depth: 1 },
            { path: 'build', type: 'directory', depth: 0 },
            { path: 'build/changed.js', type: 'file', depth: 1 },
            { path: 'build/hidden.js', type: 'file', depth: 1 },
            { path: 'build/revealed.js', type: 'file', depth: 1 },
            { path: '.env.example', type: 'file', depth: 0 },
            { path: 'node_modules', type: 'directory', depth: 0 },
        ];
        const ignoredPaths = new Set(['.git', 'build', 'build/changed.js', 'build/hidden.js', 'build/revealed.js']);
        expect(projectRepositoryTreeNodes(nodes, ignoredPaths, ['build/changed.js', 'build/revealed.js']).map(n => n.path)).toEqual([
            'build', 'build/changed.js', 'build/revealed.js', '.env.example', 'node_modules',
        ]);
        expect(projectRepositoryTreeNodes(nodes, new Set(), [])).toBe(nodes);
    });
});
