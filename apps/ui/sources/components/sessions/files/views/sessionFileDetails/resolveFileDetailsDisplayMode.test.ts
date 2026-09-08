import { describe, expect, it } from 'vitest';

import { resolveFileDetailsDisplayMode } from './resolveFileDetailsDisplayMode';

describe('resolveFileDetailsDisplayMode', () => {
    it('uses markdown preview for markdown files when no higher-priority mode is active', () => {
        expect(resolveFileDetailsDisplayMode({
            persistedEditing: false,
            deepLinkSource: null,
            hasRenderableDiff: false,
            hasFileContent: true,
            markdownPreviewAvailable: true,
        })).toBe('markdown');
    });

    it('keeps diff mode ahead of markdown preview when a renderable diff is available', () => {
        expect(resolveFileDetailsDisplayMode({
            persistedEditing: false,
            deepLinkSource: null,
            hasRenderableDiff: true,
            hasFileContent: true,
            markdownPreviewAvailable: true,
        })).toBe('diff');
    });

    it('uses markdown preview when only a placeholder diff is available', () => {
        expect(resolveFileDetailsDisplayMode({
            persistedEditing: false,
            deepLinkSource: null,
            hasRenderableDiff: false,
            hasFileContent: true,
            markdownPreviewAvailable: true,
        })).toBe('markdown');
    });

    it.each([false, true])('keeps explicit file deep links in source view while content availability is %s', (hasFileContent) => {
        expect(resolveFileDetailsDisplayMode({
            persistedEditing: false,
            deepLinkSource: 'file',
            hasRenderableDiff: true,
            hasFileContent,
            markdownPreviewAvailable: true,
        })).toBe('file');
    });

    it.each([false, true])('keeps editing drafts in source view while content availability is %s', (hasFileContent) => {
        expect(resolveFileDetailsDisplayMode({
            persistedEditing: true,
            deepLinkSource: null,
            hasRenderableDiff: true,
            hasFileContent,
            markdownPreviewAvailable: true,
        })).toBe('file');
    });
});
it('preserves an explicit file request as deferred content arrives', () => {
    for (const hasFileContent of [false, true]) {
        expect(resolveFileDetailsDisplayMode({
            requestedMode: 'file', persistedEditing: false, deepLinkSource: null,
            hasRenderableDiff: true, hasFileContent, markdownPreviewAvailable: false,
        })).toBe('file');
    }
});
it('honors the user selection ahead of restored or linked file intent', () => {
    expect(resolveFileDetailsDisplayMode({
        requestedMode: 'diff', persistedEditing: true, deepLinkSource: 'file',
        hasRenderableDiff: true, hasFileContent: false, markdownPreviewAvailable: false,
    })).toBe('diff');
});
