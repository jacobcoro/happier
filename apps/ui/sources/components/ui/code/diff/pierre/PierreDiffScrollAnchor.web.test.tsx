// @vitest-environment jsdom
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { PierreDiffScrollAnchor } from './PierreDiffScrollAnchor.web';

const patch = (lines: string[]) => `diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,${lines.length} +1,${lines.length} @@\n${lines.map((line) => ` ${line}`).join('\n')}\n`;

describe('PierreDiffScrollAnchor', () => {
    it.each([{ deferred: false, preceded: false, interrupted: false }, { deferred: true, preceded: false, interrupted: false }, { deferred: false, preceded: true, interrupted: false }, { deferred: true, preceded: false, interrupted: true }])('retains the passage (deferred: $deferred, preceding visible diff: $preceded, interrupted: $interrupted)', async ({ deferred, preceded, interrupted }) => {
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        const scroll = document.createElement('div');
        scroll.style.overflowY = 'auto';
        document.body.append(scroll);
        Object.defineProperties(scroll, { clientHeight: { value: 40 }, scrollHeight: { value: 1000 } });
        scroll.getBoundingClientRect = () => ({ top: 0, bottom: 40, height: 40 } as DOMRect);
        const contents = document.createElement('div');
        scroll.append(contents);
        if (preceded) {
            const leading = document.createElement('diffs-container');
            const leadingLine = document.createElement('div');
            leadingLine.dataset.line = '1';
            leading.append(leadingLine);
            leading.getBoundingClientRect = () => ({ top: -10, bottom: 10, height: 20 } as DOMRect);
            scroll.prepend(leading);
        }
        const oldLines = ['one', 'reading', 'three'];
        const newLines = ['inserted', ...oldLines];
        function setLines(lines: string[]) {
            contents.replaceChildren(...lines.map((text, index) => {
                const line = document.createElement('div');
                line.dataset.line = String(index + 1);
                line.dataset.lineType = 'context';
                line.textContent = text;
                line.getBoundingClientRect = () => ({ top: index * 20 - scroll.scrollTop, bottom: (index + 1) * 20 - scroll.scrollTop, height: 20 } as DOMRect);
                return line;
            }));
        }
        setLines(oldLines);
        const contentRef = { current: contents };
        function RendererBoundary({ lines }: { lines: string[] }) {
            React.useLayoutEffect(() => { if (!deferred) setLines(lines); }, [lines]);
            return null;
        }
        const view = (lines: string[]) => <PierreDiffScrollAnchor patch={patch(lines)} containerRef={contentRef}>
            <RendererBoundary lines={lines} />
        </PierreDiffScrollAnchor>;
        try {
            await act(async () => { root.render(view(oldLines)); });
            scroll.scrollTop = 25;
            await act(async () => { root.render(view(newLines)); });
            if (interrupted) {
                scroll.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown' }));
                scroll.scrollTop = 70;
            }
            if (deferred) await act(async () => { setLines(newLines); });
            if (interrupted) {
                expect(scroll.scrollTop).toBe(70);
                return;
            }
            expect(scroll.scrollTop).toBe(preceded ? 25 : 45);
            await act(async () => { root.render(view(oldLines)); });
            if (deferred) await act(async () => { setLines(oldLines); });
            expect(scroll.scrollTop).toBe(25);
        } finally {
            await act(async () => { root.unmount(); });
            container.remove();
            scroll.remove();
        }
    });
});
