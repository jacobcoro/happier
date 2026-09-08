import React from 'react';

import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import { mapCodeReadingAnchor } from '@/components/ui/code/model/mapCodeReadingAnchor';
import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';

type Props = Readonly<{
    patch: string;
    filePath?: string | null;
    scrollToLineId?: string;
    containerRef: React.RefObject<HTMLDivElement | null>;
    children: React.ReactNode;
}>;
type Snapshot = Readonly<{
    scroll: HTMLElement;
    queryRoot: HTMLElement | ShadowRoot;
    target: CodeLine;
    top: number;
    estimatedDelta: number;
    deletionColumn: boolean;
    observer: MutationObserver;
}>;

function contentLines(patch: string): CodeLine[] {
    return buildCodeLinesFromUnifiedDiff({ unifiedDiff: patch, hideFilePrelude: true })
        .filter((line) => !line.renderIsHeaderLine);
}

function findScrollContainer(host: HTMLElement): HTMLElement | null {
    for (let node: HTMLElement | null = host; node; node = node.parentElement) {
        if (node.scrollHeight <= node.clientHeight || node.clientHeight === 0) continue;
        const overflow = getComputedStyle(node).overflowY;
        if (overflow === 'auto' || overflow === 'scroll') return node;
    }
    return null;
}

/** Adapt the renderer's asynchronous DOM updates to a semantic reading anchor. */
export class PierreDiffScrollAnchor extends React.Component<Props, Record<string, never>, Snapshot | null> {
    private stopRestoring: (() => void) | null = null;
    private restorePending: (() => void) | null = null;

    override getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
        if (previous.filePath !== this.props.filePath || previous.scrollToLineId !== this.props.scrollToLineId) {
            this.stopRestoring?.();
            return null;
        }
        if (previous.patch === this.props.patch) return null;
        this.stopRestoring?.();
        const root = this.props.containerRef.current;
        if (!root) return null;
        const host = root.querySelector<HTMLElement>('diffs-container') ?? root;
        const queryRoot = host.shadowRoot ?? root;
        const scroll = findScrollContainer(host);
        if (!scroll) return null;
        const viewport = scroll.getBoundingClientRect();
        // Several review files can share this scroll root. Only its first visible
        // code host may correct the position; sibling renderers must not compete.
        const firstVisibleHost = Array.from(scroll.querySelectorAll<HTMLElement>('diffs-container')).find((candidate) => {
            const rect = candidate.getBoundingClientRect();
            return rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom
                && (candidate.shadowRoot ?? candidate).querySelector('[data-line]') !== null;
        });
        if (firstVisibleHost && firstVisibleHost !== host) return null;

        const visible = Array.from(queryRoot.querySelectorAll<HTMLElement>('[data-line]'))
            .find((line) => {
                const rect = line.getBoundingClientRect();
                return rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom;
            });
        if (!visible) return null;
        const deletionColumn = visible.closest('[data-deletions]') !== null;
        const lineNumber = Number(visible.dataset.line);
        const removal = visible.dataset.lineType === 'change-deletion';
        const previousLines = contentLines(previous.patch);
        const previousIndex = previousLines.findIndex((line) => (
            (removal ? line.kind === 'remove' : line.kind !== 'remove')
            && (removal || deletionColumn ? line.oldLine : line.newLine) === lineNumber
        ));
        if (previousIndex < 0) return null;
        const nextLines = contentLines(this.props.patch);
        const nextIndex = mapCodeReadingAnchor(previousLines.map((line) => line.renderCodeText), nextLines.map((line) => line.renderCodeText), previousIndex);
        const target = nextLines[nextIndex];
        if (!target) return null;
        const rect = visible.getBoundingClientRect();
        // Observe before child layout effects: a matching repeated line in the old DOM
        // must not be mistaken for the new patch's completed render.
        const observer = new MutationObserver(() => { this.restorePending?.(); });
        observer.observe(queryRoot, { childList: true, subtree: true, attributes: true, characterData: true });
        return { scroll, queryRoot, target, top: rect.top - viewport.top, estimatedDelta: (nextIndex - previousIndex) * rect.height, deletionColumn, observer };
    }

    override componentDidUpdate(_previous: Props, _state: Record<string, never>, snapshot: Snapshot | null) {
        if (!snapshot) return;
        const { scroll, queryRoot, target, top, deletionColumn } = snapshot;
        const restore = () => {
            const removal = target.kind === 'remove';
            const lineNumber = removal || deletionColumn ? target.oldLine : target.newLine;
            const candidates = queryRoot.querySelectorAll<HTMLElement>(`[data-line="${lineNumber}"]`);
            const line = Array.from(candidates).find((node) => (
                (node.dataset.lineType === 'change-deletion') === removal
                && (node.closest('[data-deletions]') !== null) === deletionColumn
                && (node.textContent ?? '').replace(/\n$/, '') === target.renderCodeText
            ));
            if (!line) return false;
            scroll.scrollTop += line.getBoundingClientRect().top - scroll.getBoundingClientRect().top - top;
            return true;
        };
        const observer = snapshot.observer;
        // Pierre may update synchronously or after its worker/virtualizer renders.
        if (observer.takeRecords().length > 0 && restore()) {
            observer.disconnect();
            return;
        }
        const stop = () => {
            observer.disconnect();
            scroll.removeEventListener('wheel', stop);
            scroll.removeEventListener('keydown', stop);
            scroll.removeEventListener('pointerdown', stop);
            scroll.removeEventListener('touchstart', stop);
            this.stopRestoring = null;
            this.restorePending = null;
        };
        this.stopRestoring = stop;
        this.restorePending = () => { if (restore()) stop(); };
        scroll.addEventListener('wheel', stop, { passive: true });
        scroll.addEventListener('keydown', stop);
        scroll.addEventListener('pointerdown', stop, { passive: true });
        scroll.addEventListener('touchstart', stop, { passive: true });
        // Bring an offscreen target into the virtualizer's measured window, then
        // correct its actual position when the row is rendered (including wraps/comments).
        scroll.scrollTop += snapshot.estimatedDelta;
    }

    override componentWillUnmount() { this.stopRestoring?.(); }
    override render() { return this.props.children; }
}
