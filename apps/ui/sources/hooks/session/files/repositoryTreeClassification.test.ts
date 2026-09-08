import { describe, expect, it } from 'vitest';
import { readRepositoryTreeClassification } from './repositoryTreeClassification';

describe('tree classification availability', () => {
    it('reports unavailable when an expanded empty directory cannot be classified', () => {
        const result = readRepositoryTreeClassification([{ path: 'nested', type: 'directory', isExpanded: true }], path => path
            ? { available: false, entries: [] }
            : { available: true, entries: [{ name: 'nested', type: 'directory', gitIgnored: false }] });
        expect(result.available).toBe(false);
    });
    it('collects classified ignores without treating an unloaded folder as unavailable', () => {
        const result = readRepositoryTreeClassification([{ path: 'nested', type: 'directory', isExpanded: true }], path => path
            ? { available: undefined, entries: null }
            : { available: true, entries: [{ name: '.git', type: 'directory', gitIgnored: true }] });
        expect(result.available).toBe(true);
        expect([...result.ignoredPaths]).toEqual(['.git']);
    });
});
