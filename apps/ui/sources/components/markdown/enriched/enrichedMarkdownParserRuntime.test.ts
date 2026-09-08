import React from 'react';
import TestRenderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

const wasmBoundary = vi.hoisted(() => {
    let markdown = '';
    let initializationAttempts = 0;

    return {
        factory: vi.fn(async () => {
            initializationAttempts += 1;
            if (initializationAttempts === 1) {
                throw new Error('simulated WASM initialization failure');
            }

            return {
                cwrap: () => () => (
                    markdown === 'invalid-document'
                        ? JSON.stringify({ children: [] })
                        : JSON.stringify({
                            type: 'Document',
                            children: [{
                                type: 'Paragraph',
                                children: [{ type: 'Strong', children: [{ type: 'Text', content: markdown }] }],
                            }],
                        })
                ),
                _malloc: () => 1,
                _free: () => undefined,
                stringToUTF8: (value: string) => {
                    markdown = value;
                },
                lengthBytesUTF8: (value: string) => value.length,
            };
        }),
    };
});

// The generated WASM module is the real parser's external runtime boundary.
vi.mock('../../../../node_modules/react-native-enriched-markdown/src/web/wasm/md4c.js', () => ({
    default: wasmBoundary.factory,
}));

import {
    parseMarkdown,
    parseMarkdownSyncIfReady,
    preloadMarkdownRuntime,
} from '../../../../node_modules/react-native-enriched-markdown/src/web/parseMarkdown';

describe('enriched Markdown parser runtime recovery', () => {
    it('retries initialization and recovers a warm document after a parse failure', async () => {
        await expect(preloadMarkdownRuntime()).rejects.toThrow('simulated WASM initialization failure');
        await expect(preloadMarkdownRuntime()).resolves.toBeUndefined();
        expect(wasmBoundary.factory).toHaveBeenCalledTimes(2);

        await expect(parseMarkdown('invalid-document')).rejects.toBeInstanceOf(Error);

        expect(parseMarkdownSyncIfReady('next-document')).toMatchObject({ type: 'Document' });
        expect(wasmBoundary.factory).toHaveBeenCalledTimes(2);
        const { EnrichedMarkdownText } = await import('../../../../node_modules/react-native-enriched-markdown/src/web/EnrichedMarkdownText');
        Object.assign(globalThis, { React });
        let renderer!: TestRenderer.ReactTestRenderer;
        try {
            await TestRenderer.act(async () => {
                renderer = TestRenderer.create(React.createElement(EnrichedMarkdownText, { markdown: 'invalid-document', md4cFlags: { latexMath: false } }));
            });
            expect(JSON.stringify(renderer.toJSON())).toContain('invalid-document');
            // A successful warm parse must supersede the prior error in this very
            // commit; no redundant async parse may be needed to clear stale error state.
            TestRenderer.act(() => {
                renderer.update(React.createElement(EnrichedMarkdownText, { markdown: 'recovered-document', md4cFlags: { latexMath: false } }));
            });
            expect(renderer.root.findAllByType('strong')).toHaveLength(1);
            expect(JSON.stringify(renderer.toJSON())).toContain('recovered-document');
        } finally {
            await TestRenderer.act(async () => renderer?.unmount());
        }
    });
});
