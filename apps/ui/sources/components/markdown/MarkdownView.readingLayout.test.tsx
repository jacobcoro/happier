import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installMarkdownCommonModuleMocks } from './markdownTestHelpers';

installMarkdownCommonModuleMocks();

describe('Markdown source range layout', () => {
    it('exposes real heading and paragraph layouts to the file scroll owner', async () => {
        const { MarkdownView } = await import('./MarkdownView');
        let ranges: readonly { markdown: string }[] = [];
        const observer = {
            onRanges: (next: readonly { markdown: string }[]) => { ranges = next; },
            onLayout: () => {},
        };
        const markdown = '# Heading\n\nReading paragraph.\n\nNext paragraph.';
        const screen = await renderScreen(<MarkdownView markdown={markdown} sourceRangeLayoutObserver={observer} />);
        expect(ranges.map((range) => range.markdown)).toEqual(['# Heading', 'Reading paragraph.', 'Next paragraph.']);
        expect(screen.findAllByType('View').filter((node) => node.props.onLayout && !node.props.testID)).toHaveLength(3);
        const paragraph = screen.findAllByType('EnrichedMarkdownText').find((node) => node.props.markdown === 'Reading paragraph.');
        await screen.update(<MarkdownView markdown={`Preamble.\n\n${markdown}`} sourceRangeLayoutObserver={observer} />);
        expect(screen.findAllByType('EnrichedMarkdownText').find((node) => node.props.markdown === 'Reading paragraph.')).toBe(paragraph);
    });
});
