// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { NativeScrollEvent, NativeSyntheticEvent, ScrollView } from 'react-native';
import { installMarkdownCommonModuleMocks } from './markdownTestHelpers';
import { useMarkdownReadingAnchor } from '@/components/sessions/files/file/useMarkdownReadingAnchor';

// The enriched renderer is a genuine third-party boundary; expose only rendered text to the DOM.
vi.mock('react-native-enriched-markdown', () => ({
    EnrichedMarkdownText: ({ markdown }: { markdown: string }) => <span>{markdown}</span>,
}));

installMarkdownCommonModuleMocks({ reactNative: async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const { View, Pressable } = await import('react-native-web');
    return createReactNativeWebMock({ View, Pressable });
} });

it('measures a moved unchanged RNW block without a ResizeObserver size notification', async () => {
    const { MarkdownView } = await import('./MarkdownView');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let scrollY = 0;
    let onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void = () => {};
    // jsdom has no layout engine. Model DOM geometry only; RNW, parsing, rendering and anchoring stay real.
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const index = this.parentElement?.getAttribute('data-testid') === 'markdown-static-render-content'
            ? Array.from(this.parentElement.children).indexOf(this) : 0;
        return { top: index * 100 - scrollY, left: 0, width: 600, height: 100, bottom: (index + 1) * 100 - scrollY, right: 600, x: 0, y: index * 100 - scrollY, toJSON: () => ({}) };
    });
    function Preview({ markdown }: { markdown: string }) {
        const reading = useMarkdownReadingAnchor('same-file', 24);
        onScroll = reading.onScroll;
        reading.scrollRef.current = { scrollTo: ({ y }: { y: number }) => { scrollY = y; } } as unknown as ScrollView;
        return <MarkdownView markdown={markdown} sourceRangeLayoutObserver={reading.observer} />;
    }
    try {
        const markdown = '# Heading\n\nReading passage.\n\nNext passage.';
        await act(async () => root.render(<Preview markdown={markdown} />));
        scrollY = 144;
        onScroll({ nativeEvent: { contentOffset: { x: 0, y: scrollY } } } as NativeSyntheticEvent<NativeScrollEvent>);
        await act(async () => root.render(<Preview markdown={`Inserted paragraph.\n\n${markdown}`} />));
        expect(scrollY).toBe(244);
    } finally {
        await act(async () => root.unmount());
        measure.mockRestore();
        container.remove();
    }
});
