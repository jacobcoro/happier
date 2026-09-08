import React from 'react';
import type { CodeLine } from '../model/codeLineTypes';
import { mapCodeReadingAnchor } from '../model/mapCodeReadingAnchor';

export type NativeCodeReadingAnchor = Readonly<{ index: number; offset: number }>;
type Props = Readonly<{
    lines: readonly CodeLine[];
    scrollToLineId?: string;
    viewId?: string;
    getRoot: () => unknown;
    getNativeAnchor?: (lines: readonly CodeLine[]) => NativeCodeReadingAnchor | null;
    nativeAnchor?: React.RefObject<NativeCodeReadingAnchor | null>;
    scrollToIndex?: (index: number, offset: number) => void;
    children: React.ReactNode;
}>;
type Snapshot = Readonly<{
    index: number;
    offset: number;
    scroller?: HTMLElement;
}> | null;

/** Capture layout before React replaces index-keyed rows, including external scroll parents. */
export class CodeLinesReadingAnchor extends React.Component<Props, object, Snapshot> {
    private frame: number | null = null;

    getSnapshotBeforeUpdate(previous: Props): Snapshot {
        if (previous.lines === this.props.lines || previous.scrollToLineId !== this.props.scrollToLineId) return null;
        if (previous.lines.length === this.props.lines.length
            && previous.lines.every((line, index) => line.renderCodeText === this.props.lines[index]?.renderCodeText)) return null;
        const root = this.props.getRoot();
        let anchor: Snapshot = this.props.getNativeAnchor?.(previous.lines) ?? this.props.nativeAnchor?.current ?? null;
        if (typeof HTMLElement !== 'undefined' && root instanceof HTMLElement) {
            if (!this.props.viewId) return null;
            let scroller: HTMLElement | null = root;
            while (scroller) {
                const overflow = getComputedStyle(scroller).overflowY;
                if ((overflow === 'auto' || overflow === 'scroll') && scroller.scrollHeight > scroller.clientHeight) break;
                scroller = scroller.parentElement;
            }
            if (!scroller || scroller.clientHeight === 0) return null;
            const viewportTop = scroller.getBoundingClientRect().top;
            const viewportBottom = viewportTop + scroller.clientHeight;
            const bounds = root.getBoundingClientRect();
            if (bounds.top > viewportTop || bounds.bottom <= viewportTop) return null;
            const row = Array.from(root.querySelectorAll<HTMLElement>(`[id^="${this.props.viewId}-"]`)).find((candidate) => {
                const rect = candidate.getBoundingClientRect();
                return rect.bottom > viewportTop && rect.top < viewportBottom;
            });
            if (!row) return null;
            anchor = { index: previous.lines.findIndex((line) => row.id === `${this.props.viewId}-${line.id}`), offset: row.getBoundingClientRect().top - viewportTop, scroller };
        }
        if (!anchor) return null;
        const index = mapCodeReadingAnchor(
            previous.lines.map((line) => line.renderCodeText),
            this.props.lines.map((line) => line.renderCodeText),
            anchor.index,
        );
        return index < 0 ? null : { ...anchor, index };
    }

    componentDidUpdate(_previous: Props, _state: object, snapshot: Snapshot) {
        if (this.frame !== null) cancelAnimationFrame(this.frame);
        this.frame = null;
        if (!snapshot) return;
        const { scroller, index, offset } = snapshot;
        if (!scroller) {
            if (this.props.nativeAnchor?.current) this.props.nativeAnchor.current = { index, offset };
            this.props.scrollToIndex?.(index, offset);
            return;
        }
        const restore = () => {
            const root = this.props.getRoot();
            if (!(root instanceof HTMLElement) || scroller.clientHeight === 0) return false;
            const row = Array.from(root.querySelectorAll<HTMLElement>(`[id^="${this.props.viewId}-"]`)).find((row) => row.id === `${this.props.viewId}-${this.props.lines[index]?.id}`);
            if (!row) return false;
            scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset;
            return true;
        };
        if (!restore() && this.props.scrollToIndex) {
            this.props.scrollToIndex(index, offset);
            this.frame = requestAnimationFrame(() => { this.frame = null; restore(); });
        }
    }

    componentWillUnmount() {
        if (this.frame !== null) cancelAnimationFrame(this.frame);
    }

    render() { return this.props.children; }
}
