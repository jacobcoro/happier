import type { FileDisplayMode } from '@/components/sessions/files/file/FileActionToolbar';
import type { ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';

export function resolveFileDetailsDisplayMode(input: Readonly<{
    requestedMode?: FileDisplayMode | null;
    persistedEditing: boolean;
    deepLinkSource: ReviewCommentSource | null;
    hasRenderableDiff: boolean;
    hasFileContent: boolean;
    markdownPreviewAvailable: boolean;
}>): FileDisplayMode {
    if (input.requestedMode) return input.requestedMode;
    if (input.deepLinkSource === 'file') return 'file';
    if (input.deepLinkSource === 'diff' && input.hasRenderableDiff) return 'diff';
    if (input.persistedEditing) return 'file';
    if (input.hasRenderableDiff) return 'diff';
    if (input.markdownPreviewAvailable) return 'markdown';
    if (input.hasFileContent) return 'file';
    return 'diff';
}
