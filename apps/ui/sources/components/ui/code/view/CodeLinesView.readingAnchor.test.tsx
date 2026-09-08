// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCodeLinesFromFile } from '../model/buildCodeLinesFromFile';

const containers: HTMLElement[] = [];
afterEach(() => { containers.splice(0).forEach((node) => node.remove()); vi.restoreAllMocks(); });

describe('CodeLinesView reading continuity', () => {
    it('lets only the viewer containing the viewport top restore a shared scroll parent', async () => {
        const { CodeLinesReadingAnchor } = await import('./CodeLinesReadingAnchor');
        const scroller = document.createElement('div');
        scroller.style.overflowY = 'auto';
        Object.defineProperties(scroller, { clientHeight: { value: 100 }, scrollHeight: { value: 1000 } });
        document.body.appendChild(scroller);
        containers.push(scroller);
        scroller.scrollTop = 20;
        const root = createRoot(scroller);
        const refs = [React.createRef<HTMLDivElement>(), React.createRef<HTMLDivElement>()];
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            const top = this === scroller ? 0 : this.dataset.top ? Number(this.dataset.top) - scroller.scrollTop : 0;
            return { top, bottom: top + 40, height: 40, width: 100, left: 0, right: 100, x: 0, y: top, toJSON() {} };
        });
        const render = (changed: boolean) => root.render(<>{refs.map((ref, viewer) => {
            const lines = buildCodeLinesFromFile({ text: changed ? 'inserted\nreading' : 'reading' });
            return <CodeLinesReadingAnchor key={viewer} viewId={`v${viewer}`} lines={lines} getRoot={() => ref.current}>
                <div ref={ref} data-top={viewer * 80}>{lines.map((line, index) => <div key={line.id} id={`v${viewer}-${line.id}`} data-top={viewer * 80 + index * (viewer === 0 ? 20 : 40)}>{line.renderCodeText}</div>)}</div>
            </CodeLinesReadingAnchor>;
        })}</>);
        await act(async () => render(false));
        await act(async () => render(true));
        expect(scroller.scrollTop).toBe(40);
        await act(async () => root.unmount());
    });

    it('restores the native list to the mapped passage with its measured viewport offset', async () => {
        const { CodeLinesReadingAnchor } = await import('./CodeLinesReadingAnchor');
        const host = document.createElement('div');
        document.body.appendChild(host);
        containers.push(host);
        const root = createRoot(host);
        let visibleIndex = 2;
        let visibleOffset = -7;
        const nativeAnchor = { current: { index: 2, offset: -7 } };
        const render = (text: string) => root.render(<CodeLinesReadingAnchor
            lines={buildCodeLinesFromFile({ text })}
            getRoot={() => null}
            nativeAnchor={nativeAnchor}
            scrollToIndex={(index, offset) => { visibleIndex = index; visibleOffset = offset; }}
        >native list</CodeLinesReadingAnchor>);
        await act(async () => render('a\nb\nreading\nd'));
        await act(async () => render('inserted\na\nb\nreading\nd'));
        expect(visibleIndex).toBe(3);
        expect(visibleOffset).toBe(-7);
        await act(async () => render('second\ninserted\na\nb\nreading\nd'));
        expect(visibleIndex).toBe(4);
        expect(visibleOffset).toBe(-7);
        await act(async () => root.unmount());
    });

    it('keeps the same passage and intra-line offset after wrapped insertion above an externally scrolled view', async () => {
        const { CodeLinesReadingAnchor } = await import('./CodeLinesReadingAnchor');
        const scroller = document.createElement('div');
        scroller.style.overflowY = 'auto';
        document.body.appendChild(scroller);
        containers.push(scroller);
        Object.defineProperties(scroller, { clientHeight: { value: 40 }, scrollHeight: { value: 1000 } });
        scroller.scrollTop = 45;
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            const index = this.getAttribute('data-code-line-index');
            const rows = Array.from(scroller.querySelectorAll<HTMLElement>('[data-code-view-id="primary"]'));
            if (this.dataset.codeViewId === 'nested') return { top: 5, bottom: 25, left: 0, right: 100, height: 20, width: 100, x: 0, y: 5, toJSON() {} };
            const top = index === null ? 0 : rows.slice(0, Number(index)).reduce((total, row) => total + (row.textContent === 'inserted' ? 40 : 20), 0) - scroller.scrollTop;
            return { top, bottom: top + (index === null ? 40 : 20), left: 0, right: 100, height: 20, width: 100, x: 0, y: top, toJSON() {} };
        });
        const root = createRoot(scroller);
        const render = (text: string) => {
            const lines = buildCodeLinesFromFile({ text });
            root.render(<CodeLinesReadingAnchor lines={lines} viewId="primary" getRoot={() => scroller}>
                <div id="nested-f:4" data-code-view-id="nested" data-code-line-index={3}>nested code</div>
                {lines.map((line, index) => <div key={line.id} id={`primary-${line.id}`} data-code-view-id="primary" data-code-line-index={index}>{line.renderCodeText}</div>)}
            </CodeLinesReadingAnchor>);
        };
        await act(async () => render('a\nb\nreading\nd\ne\nf'));
        await act(async () => render('inserted\na\nb\nreading\nd\ne\nf'));
        expect(scroller.scrollTop).toBe(85);
        await act(async () => render('inserted\na\nb\nreading\nd\ne\nf'));
        expect(scroller.scrollTop).toBe(85);
        await act(async () => root.unmount());
    });
});
