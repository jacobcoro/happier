import { describe, expect, it } from 'vitest';
import { mapCodeReadingAnchor, mapCodeReadingAnchors } from './mapCodeReadingAnchor';

describe('mapCodeReadingAnchor', () => {
    it('keeps the reading passage through insertions and removals above it', () => {
        const previous = ['start', 'remove me', '', 'reading', '', 'end'];
        const next = ['intro', 'another', 'start', '', 'reading', '', 'end'];
        expect(mapCodeReadingAnchor(previous, next, 3)).toBe(4);
        expect(mapCodeReadingAnchor(next, previous, 4)).toBe(3);
    });
    it('maps repeated lines in their sequence context', () => {
        expect(mapCodeReadingAnchor(['a', '', 'b', '', 'c'], ['inserted', 'a', '', 'b', '', 'c'], 3)).toBe(4);
    });
    it('uses surrounding passage context when both ends and duplicate lines change', () => {
        const previous = ['old intro', 'other', '', 'before', '', 'after', 'old ending'];
        const next = ['new intro', 'new line', 'other', '', 'before', '', 'after', 'new ending'];
        expect(mapCodeReadingAnchor(previous, next, 4)).toBe(5);
    });
    it('keeps a valid position when a large file is replaced completely', () => {
        const previous = Array.from({ length: 100_000 }, (_, index) => `old ${index}`);
        const next = Array.from({ length: 100_000 }, (_, index) => `new ${index}`);
        expect(mapCodeReadingAnchor(previous, next, 50_000)).toBe(50_000);
    });
    it('uses the next surviving passage when the anchored passage is deleted', () => {
        expect(mapCodeReadingAnchor(['a', 'removed', 'c'], ['a', 'c'], 1)).toBe(1);
        expect(mapCodeReadingAnchor(['a', 'removed'], ['a'], 1)).toBe(0);
        expect(mapCodeReadingAnchor(['a'], [], 0)).toBe(-1);
        expect(mapCodeReadingAnchor([], ['a', 'b'], 0)).toBe(0);
    });
});


describe('mapCodeReadingAnchors', () => {
    it('maps surviving anchors together without assigning deleted or ambiguous text', () => {
        expect(mapCodeReadingAnchors(
            ['head', 'old', 'unique', '', '', 'tail'],
            ['head', 'new', 'intro', 'unique', '', '', 'changed tail'],
            [0, 1, 2, 3, 4, 5],
        )).toEqual([0, null, 3, 4, 5, null]);
        expect(mapCodeReadingAnchors(['x', 'x'], ['intro', 'x', 'x', 'outro'], [0, 1])).toEqual([null, null]);
        expect(mapCodeReadingAnchors(['head', '', '', 'tail'], ['intro', 'head', '', '', 'tail'], [1, 2]))
            .toEqual([2, 3]);
    });
});
