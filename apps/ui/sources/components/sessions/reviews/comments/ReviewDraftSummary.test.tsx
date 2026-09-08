import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { ReviewDraftSummary } from './ReviewDraftSummary';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());
vi.mock('@/components/ui/text/Text', async () => (await import('@/dev/testkit/mocks/uiText')).createUiTextModuleMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: (key, params) => params ? JSON.stringify(params) : key }));

const drafts: readonly ReviewCommentDraft[] = [true, false].map((includeInPrompt, index) => ({
    id: String(index), filePath: 'file.ts', source: 'file', anchor: { kind: 'fileLine', startLine: 1 },
    snapshot: { selectedLines: [], beforeContext: [], afterContext: [] }, body: 'Review this', createdAt: 1, includeInPrompt,
}));

describe('ReviewDraftSummary', () => {
    it('shows prompt inclusion and hands off without changing saved drafts', async () => {
        let destination = 'review';
        const before = JSON.stringify(drafts);
        const screen = await renderScreen(<ReviewDraftSummary enabled drafts={drafts} onGoToComposer={() => { destination = 'composer'; }} />);
        expect(screen.getTextContent()).toContain('"included":1,"count":2');
        await act(async () => { screen.pressByTestId('review-drafts-go-to-composer'); });
        expect(destination).toBe('composer');
        expect(JSON.stringify(drafts)).toBe(before);
    });
    it('hides disabled or empty summaries', async () => {
        const screen = await renderScreen(<ReviewDraftSummary enabled={false} drafts={drafts} onGoToComposer={() => {}} />);
        expect(screen.findAllByTestId('review-drafts-go-to-composer')).toHaveLength(0);
        await act(async () => { screen.tree.update(<ReviewDraftSummary enabled drafts={[]} onGoToComposer={() => {}} />); });
        expect(screen.findAllByTestId('review-drafts-go-to-composer')).toHaveLength(0);
    });
});
