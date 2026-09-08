import type { MarkdownBlock } from '../parseMarkdown';
import type { MarkdownSourceRange } from '../parseMarkdown';

export type MarkdownRenderSegment = Readonly<{
    type: 'enriched-markdown';
    /** Rendering includes document-wide definitions; source identity stays local. */
    renderMarkdown?: string;
    key: string;
    sourceStart: number;
    sourceLength: number;
    sourceHash: string;
    sourceRange: MarkdownSourceRange;
    markdown: string;
    first: boolean;
    last: boolean;
}> | Readonly<{
    type: 'special-block';
    key: string;
    sourceStart: number;
    sourceLength: number;
    sourceHash: string;
    sourceRange: MarkdownSourceRange;
    markdown: string;
    blocks: readonly MarkdownBlock[];
    first: boolean;
    last: boolean;
}>;
