import React from 'react';
import { FlatList, Platform, View } from 'react-native';

import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import type { CodeLinesSyntaxHighlightingConfig } from '@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting';

import { CodeLineRow } from './CodeLineRow';
import { CodeLinesReadingAnchor, type NativeCodeReadingAnchor } from './CodeLinesReadingAnchor';
import { resolveEffectiveSyntaxHighlighting } from './resolveEffectiveSyntaxHighlighting';
import { buildCodeLineRange, isCodeLineRangeSelectionEvent } from '../interactions/resolveCodeLineRangeSelection';

export type CodeLinesExternalScrollView = Readonly<{
    scrollRef: React.RefObject<{ scrollTo: (options: { y: number; animated: boolean }) => void } | null>;
    contentRef?: React.RefObject<View | null>;
    viewportRef?: React.RefObject<View | null>;
    offsetRef: React.RefObject<number>;
}>;

function measureExternalLayout(
    owner: CodeLinesExternalScrollView,
    row: View,
    measured: (x: number, y: number, width: number, height: number) => void,
): void {
    const content = owner.contentRef?.current;
    if (content) {
        row.measureLayout(content, measured);
        return;
    }
    owner.viewportRef?.current?.measureInWindow((_x, viewportY) => {
        row.measureInWindow((x, y, width, height) => {
            measured(x, y - viewportY + owner.offsetRef.current, width, height);
        });
    });
}

export type CodeLinesViewProps = {
    lines: readonly CodeLine[];
    selectedLineIds?: ReadonlySet<string>;
    onPressLine?: (line: CodeLine, event?: unknown) => void;
    onPressLineRange?: (lines: readonly CodeLine[]) => void;
    pressLineWhenNotSelectable?: boolean;
    onPressAddComment?: (line: CodeLine) => void;
    isCommentActive?: (line: CodeLine) => boolean;
    renderAfterLine?: (line: CodeLine) => React.ReactNode;
    showInactiveCommentAffordance?: boolean;
    contentPaddingHorizontal?: number;
    contentPaddingVertical?: number;
    wrapLines?: boolean;
    virtualized?: boolean;
    showLineNumbers?: boolean;
    showPrefix?: boolean;
    syntaxHighlighting?: CodeLinesSyntaxHighlightingConfig;
    scrollToLineId?: string;
    /** Inline native viewers delegate measured targets to their enclosing scroll owner. */
    onScrollToLine?: (windowY: number) => void;
    externalScrollView?: CodeLinesExternalScrollView;
    highlightLineId?: string;
    highlightLineIds?: ReadonlySet<string>;
    testID?: string;
    onLayout?: (e: any) => void;
    onContentSizeChange?: (width: number, height: number) => void;
    onScroll?: (e: any) => void;
    scrollEventThrottle?: number;
};

type InlineToken = Readonly<{ text: string; color: string }>;
type PreventableEvent = Readonly<{
    preventDefault?: () => void;
    nativeEvent?: Readonly<{ preventDefault?: () => void }>;
}>;

const EMPTY_LINE_ID_SET: ReadonlySet<string> = new Set();
const VIRTUALIZED_LIST_STYLE = { flex: 1, minHeight: 0 } as const;
const LIST_FOOTER_STYLE = { height: 16 } as const;

function preventNativeTextSelection(event?: PreventableEvent): void {
    event?.preventDefault?.();
    event?.nativeEvent?.preventDefault?.();
}

export function CodeLinesViewCore(
    props: CodeLinesViewProps & Readonly<{
        getAdvancedTokens?: (index: number) => readonly InlineToken[] | null | undefined;
        advancedTokensRevision?: number;
    }>
) {
    const lineRefs = React.useRef(new Map<string, View>());
    const externalRowLayouts = React.useRef(new Map<string, { y: number; height: number }>());
    const measureExternalRow = React.useCallback((id: string) => {
        const owner = props.externalScrollView;
        const row = lineRefs.current.get(id);
        if (Platform.OS === 'web' || !owner || !row) return;
        measureExternalLayout(owner, row, (_x, y, _width, height) => {
            if (lineRefs.current.get(id) === row) externalRowLayouts.current.set(id, { y, height });
        });
    }, [props.externalScrollView]);
    const lineNativeIdPrefix = React.useId();
    const completedScrollTarget = React.useRef<string | null>(null);
    const contentRef = React.useRef<View | null>(null);
    const nativeReadingAnchor = React.useRef<NativeCodeReadingAnchor | null>(null);
    const pendingReadingScroll = React.useRef<NativeCodeReadingAnchor | null>(null);
    const nativeScrollOffset = React.useRef(0);
    const readingLinesRef = React.useRef(props.lines);
    readingLinesRef.current = props.lines;
    const measureNativeReadingAnchor = React.useCallback(() => {
        if (Platform.OS === 'web') return;
        const anchor = nativeReadingAnchor.current;
        if (!anchor) return;
        const lines = readingLinesRef.current;
        const line = lines[anchor.index];
        const row = line ? lineRefs.current.get(line.id) : null;
        const scrollView = listRef.current?.getNativeScrollRef?.();
        if (!row || !scrollView || !('measureInWindow' in scrollView)) return;
        scrollView.measureInWindow((_x, viewportY) => {
            row.measureInWindow((_rowX, rowY) => {
                if (nativeReadingAnchor.current !== anchor || readingLinesRef.current !== lines) return;
                nativeReadingAnchor.current = { index: anchor.index, offset: rowY - viewportY };
            });
        });
    }, []);
    const onViewableItemsChanged = React.useCallback(({ viewableItems }: { viewableItems: Array<{ index: number | null }> }) => {
        const index = viewableItems.find((item) => item.index !== null)?.index;
        if (index !== undefined && index !== null) {
            nativeReadingAnchor.current = { index, offset: 0 };
            measureNativeReadingAnchor();
        }
    }, [measureNativeReadingAnchor]);
    const selected = props.selectedLineIds ?? EMPTY_LINE_ID_SET;
    const highlighted = props.highlightLineIds ?? EMPTY_LINE_ID_SET;
    const paddingHorizontal = props.contentPaddingHorizontal ?? 0;
    const paddingVertical = props.contentPaddingVertical ?? 0;
    const wrapLines = props.wrapLines ?? true;
    const virtualized = props.virtualized ?? true;
    const showLineNumbers = props.showLineNumbers ?? true;
    const showPrefix = props.showPrefix ?? true;
    const advancedTokensRevision = props.advancedTokensRevision ?? 0;
    const activeRangeStartLineIdRef = React.useRef<string | null>(null);
    const lastPressedLineIdRef = React.useRef<string | null>(null);

    const onBeginLineRangeSelection = React.useCallback((line: CodeLine, event?: PreventableEvent) => {
        if (!props.onPressLineRange || line.renderIsHeaderLine) return;
        preventNativeTextSelection(event);
        activeRangeStartLineIdRef.current = line.id;
    }, [props.onPressLineRange]);

    const onEnterLineRangeSelection = React.useCallback((line: CodeLine, event?: PreventableEvent) => {
        const startLineId = activeRangeStartLineIdRef.current;
        if (!startLineId || !props.onPressLineRange || line.renderIsHeaderLine) return;
        preventNativeTextSelection(event);
        if (startLineId === line.id) return;
        const rangeLines = buildCodeLineRange({
            lines: props.lines,
            fromLineId: startLineId,
            toLineId: line.id,
        });
        if (rangeLines.length > 0) props.onPressLineRange(rangeLines);
    }, [props.lines, props.onPressLineRange]);

    const onEndLineRangeSelection = React.useCallback((event?: PreventableEvent) => {
        preventNativeTextSelection(event);
        activeRangeStartLineIdRef.current = null;
    }, []);

    const onPressLine = React.useCallback((line: CodeLine, event?: unknown) => {
        if (line.renderIsHeaderLine) return;
        const previousLineId = lastPressedLineIdRef.current;
        if (
            previousLineId &&
            previousLineId !== line.id &&
            props.onPressLineRange &&
            isCodeLineRangeSelectionEvent(event)
        ) {
            const rangeLines = buildCodeLineRange({
                lines: props.lines,
                fromLineId: previousLineId,
                toLineId: line.id,
            });
            if (rangeLines.length > 0) {
                props.onPressLineRange(rangeLines);
                lastPressedLineIdRef.current = line.id;
                return;
            }
        }

        props.onPressLine?.(line, event);
        lastPressedLineIdRef.current = line.id;
    }, [props.lines, props.onPressLine, props.onPressLineRange]);

    const effectiveSyntaxHighlighting = React.useMemo(() => {
        return resolveEffectiveSyntaxHighlighting({ lines: props.lines, config: props.syntaxHighlighting });
    }, [props.lines, props.syntaxHighlighting]);

    const renderLine = React.useCallback((item: CodeLine, index: number) => (
        <View
            collapsable={false}
            nativeID={`${lineNativeIdPrefix}-${item.id}`}
            onLayout={props.externalScrollView ? () => measureExternalRow(item.id) : undefined}
            ref={(node) => {
                if (node) lineRefs.current.set(item.id, node);
                else lineRefs.current.delete(item.id);
            }}
        >
            <CodeLineRow
                line={item}
                selected={selected.has(item.id)}
                highlighted={props.highlightLineId === item.id || highlighted.has(item.id)}
                onPressLine={onPressLine}
                onBeginLineRangeSelection={props.onPressLineRange ? onBeginLineRangeSelection : undefined}
                onEnterLineRangeSelection={props.onPressLineRange ? onEnterLineRangeSelection : undefined}
                onEndLineRangeSelection={props.onPressLineRange ? onEndLineRangeSelection : undefined}
                pressLineWhenNotSelectable={props.pressLineWhenNotSelectable}
                onPressAddComment={props.onPressAddComment}
                commentActive={props.isCommentActive ? props.isCommentActive(item) : false}
                showInactiveCommentAffordance={props.showInactiveCommentAffordance}
                wrapLines={wrapLines}
                showLineNumbers={showLineNumbers}
                showPrefix={showPrefix}
                syntaxHighlighting={effectiveSyntaxHighlighting}
                advancedTokens={effectiveSyntaxHighlighting.mode === 'advanced' ? (props.getAdvancedTokens?.(index) ?? undefined) : undefined}
            />
            {props.renderAfterLine ? props.renderAfterLine(item) : null}
        </View>
    ), [
        lineNativeIdPrefix,
        measureExternalRow,
        props.externalScrollView,
        effectiveSyntaxHighlighting,
        highlighted,
        onBeginLineRangeSelection,
        onEndLineRangeSelection,
        onEnterLineRangeSelection,
        onPressLine,
        props.getAdvancedTokens,
        props.highlightLineId,
        props.isCommentActive,
        props.onPressAddComment,
        props.onPressLineRange,
        props.pressLineWhenNotSelectable,
        props.renderAfterLine,
        props.showInactiveCommentAffordance,
        selected,
        showLineNumbers,
        showPrefix,
        wrapLines,
    ]);

    const renderItem = React.useCallback(({ item, index }: { item: CodeLine; index: number }) => {
        return renderLine(item, index);
    }, [renderLine]);

    const contentContainerStyle = React.useMemo(() => ({
        paddingHorizontal,
        paddingVertical,
    }), [paddingHorizontal, paddingVertical]);

    const listFooterComponent = React.useMemo(() => <View style={LIST_FOOTER_STYLE} />, []);

    const listRef = React.useRef<FlatList<CodeLine> | null>(null);

    const scrollIndex = React.useMemo(() => {
        const id = props.scrollToLineId;
        if (!id) return -1;
        return props.lines.findIndex((l) => l.id === id);
    }, [props.lines, props.scrollToLineId]);

    const estimatedRowHeight = 22;

    const getItemLayout = React.useCallback((_: unknown, index: number) => {
        // A best-effort constant-height layout to make scroll-to-index reliable on React Native Web.
        // If a line wraps, the offset can be slightly off, but the highlight still guides the user.
        return {
            length: estimatedRowHeight,
            offset: estimatedRowHeight * index,
            index,
        };
    }, [estimatedRowHeight]);

    React.useEffect(() => {
        const targetId = props.scrollToLineId;
        if (!targetId) {
            completedScrollTarget.current = null;
            return;
        }
        if (scrollIndex < 0 || completedScrollTarget.current === targetId) return;
        const firstLineId = props.lines[0]?.id ?? null;

        let cancelled = false;

        const tryScrollIntoView = (): boolean => {
            if (typeof document === 'undefined') return false;
            // React Native Web maps `nativeID` to DOM `id`.
            const el = (document as any)?.getElementById?.(`${lineNativeIdPrefix}-${targetId}`);
            if (!el) return false;
            if (typeof el.scrollIntoView !== 'function') return false;
            try {
                el.scrollIntoView({ block: 'center' });
                return true;
            } catch {
                return false;
            }
        };

        const tryScrollDomOffset = (): boolean => {
            if (typeof document === 'undefined') return false;
            const doc: any = document as any;
            const fallbackAnchor = doc?.getElementById?.(`${lineNativeIdPrefix}-${targetId}`)
                ?? (firstLineId ? doc?.getElementById?.(`${lineNativeIdPrefix}-${firstLineId}`) : null);
            if (!fallbackAnchor) return false;

            let el = fallbackAnchor.parentElement;
            let steps = 0;
            while (el && steps < 30) {
                const overflowY = (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function')
                    ? window.getComputedStyle(el).overflowY
                    : null;
                const overflowOk = overflowY ? (overflowY === 'auto' || overflowY === 'scroll') : true;
                if (overflowOk && el.scrollHeight > el.clientHeight + 5) {
                    const top = estimatedRowHeight * scrollIndex;
                    try {
                        if (typeof el.scrollTo === 'function') {
                            el.scrollTo({ top });
                        } else {
                            el.scrollTop = top;
                        }
                    } catch {
                        try {
                            el.scrollTop = estimatedRowHeight * scrollIndex;
                        } catch {
                            // ignore
                        }
                    }
                    return true;
                }
                el = el.parentElement;
                steps++;
            }

            return false;
        };

        const attemptScroll = () => {
            if (cancelled) return;
            pendingReadingScroll.current = null;
            if (!virtualized && typeof document === 'undefined') {
                const row = lineRefs.current.get(targetId);
                const owner = props.externalScrollView;
                if (row && owner) {
                    measureExternalLayout(owner, row, (_x, y) => {
                        if (cancelled) return;
                        const scrollY = Math.max(0, y);
                        completedScrollTarget.current = targetId;
                        owner.offsetRef.current = scrollY;
                        owner.scrollRef.current?.scrollTo({ y: scrollY, animated: true });
                    });
                    return;
                }
                if (!props.onScrollToLine) return;
                row?.measureInWindow((_x, y) => {
                    if (cancelled) return;
                    completedScrollTarget.current = targetId;
                    props.onScrollToLine?.(y);
                });
                return;
            }
            // Defer until after layout to avoid "no item at index" on first paint.
            try {
                if (listRef.current) {
                    listRef.current.scrollToIndex({ index: scrollIndex, viewPosition: 0.25, animated: true });
                    completedScrollTarget.current = targetId;
                }
            } catch {
                // ignore
            }
            // React Native Web sometimes fails to forward FlatList refs; fall back to DOM scrollTop.
            const offsetScrolled = tryScrollDomOffset();
            if (tryScrollIntoView() || offsetScrolled) completedScrollTarget.current = targetId;
        };

        let attempts = 0;
        let timer: any = null;
        const tick = () => {
            attempts += 1;
            attemptScroll();
            if (cancelled) return;
            // Retry briefly to catch layout + virtualization rendering on web.
            if (attempts < 6 && typeof document !== 'undefined') {
                timer = setTimeout(tick, 50);
            }
        };

        timer = setTimeout(tick, 0);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [estimatedRowHeight, lineNativeIdPrefix, props.lines, props.externalScrollView, props.onScrollToLine, props.scrollToLineId, scrollIndex, virtualized]);

    // FlatList is a PureComponent: when behavior depends on props outside `data`, we must provide `extraData`
    // to ensure rows get re-rendered. This matters for "selected" state and inline review-comment composers.
    const listExtraData = React.useMemo(() => ({
        selectedLineIds: props.selectedLineIds,
        renderAfterLine: props.renderAfterLine,
        onPressLine: props.onPressLine,
        onPressLineRange: props.onPressLineRange,
        pressLineWhenNotSelectable: props.pressLineWhenNotSelectable,
        onPressAddComment: props.onPressAddComment,
        isCommentActive: props.isCommentActive,
        showInactiveCommentAffordance: props.showInactiveCommentAffordance,
        wrapLines,
        showLineNumbers,
        showPrefix,
        syntaxHighlighting: effectiveSyntaxHighlighting,
        highlightLineId: props.highlightLineId,
        highlightLineIds: props.highlightLineIds,
        advancedTokensRevision,
    } as const), [
        effectiveSyntaxHighlighting,
        advancedTokensRevision,
        props.highlightLineId,
        props.highlightLineIds,
        props.isCommentActive,
        props.onPressAddComment,
        props.onPressLine,
        onPressLine,
        props.onPressLineRange,
        props.pressLineWhenNotSelectable,
        props.renderAfterLine,
        props.selectedLineIds,
        props.showInactiveCommentAffordance,
        showLineNumbers,
        showPrefix,
        wrapLines,
    ]);

    const preserveReadingAnchor = (children: React.ReactNode) => (
        <CodeLinesReadingAnchor
            lines={props.lines}
            viewId={lineNativeIdPrefix}
            scrollToLineId={props.scrollToLineId}
            getRoot={() => virtualized ? listRef.current?.getNativeScrollRef?.() : contentRef.current}
            nativeAnchor={Platform.OS === 'web' ? undefined : nativeReadingAnchor}
            getNativeAnchor={!virtualized && props.externalScrollView ? (lines) => {
                const scrollY = props.externalScrollView!.offsetRef.current;
                const first = lines[0] ? externalRowLayouts.current.get(lines[0].id) : null;
                // Inline siblings share one viewport: only its top passage owns restoration.
                if (!first || scrollY < first.y) return null;
                const index = lines.findIndex((line) => {
                    const layout = externalRowLayouts.current.get(line.id);
                    return layout !== undefined && layout.y + layout.height > scrollY;
                });
                const layout = index >= 0 ? externalRowLayouts.current.get(lines[index].id) : null;
                return layout ? { index, offset: layout.y - scrollY } : null;
            } : undefined}
            scrollToIndex={virtualized ? (index, offset) => {
                pendingReadingScroll.current = { index, offset };
                const lines = props.lines;
                const target = lines[index];
                const row = target ? lineRefs.current.get(target.id) : null;
                const scrollView = listRef.current?.getNativeScrollRef?.();
                if (Platform.OS !== 'web' && row && scrollView && 'measureInWindow' in scrollView) {
                    scrollView.measureInWindow((_x, viewportY) => {
                        row.measureInWindow((_rowX, rowY) => {
                            if (readingLinesRef.current !== lines) return;
                            const nextOffset = Math.max(0, nativeScrollOffset.current + rowY - viewportY - offset);
                            nativeScrollOffset.current = nextOffset;
                            listRef.current?.scrollToOffset({ offset: nextOffset, animated: false });
                        });
                    });
                } else {
                    listRef.current?.scrollToIndex({ index, viewOffset: offset, animated: false });
                }
            } : props.externalScrollView ? (index, offset) => {
                const owner = props.externalScrollView;
                const line = props.lines[index];
                const row = line ? lineRefs.current.get(line.id) : null;
                if (!owner || !row || !line) return;
                measureExternalLayout(owner, row, (_x, y, _width, height) => {
                    if (readingLinesRef.current !== props.lines) return;
                    externalRowLayouts.current.set(line.id, { y, height });
                    const scrollY = Math.max(0, y - offset);
                    owner.offsetRef.current = scrollY;
                    owner.scrollRef.current?.scrollTo({ y: scrollY, animated: false });
                });
            } : undefined}
        >
            {children}
        </CodeLinesReadingAnchor>
    );

    if (!virtualized) {
        return preserveReadingAnchor(
            <View ref={contentRef} style={{ paddingHorizontal, paddingVertical }}>
                {props.lines.map((line, index) => (
                    <React.Fragment key={line.id}>
                        {renderLine(line, index)}
                    </React.Fragment>
                ))}
                <View style={{ height: 16 }} />
            </View>
        );
    }

    return preserveReadingAnchor(
        <FlatList
            ref={(node) => {
                // react-test-renderer does not provide a stable ref object; we store it manually.
                listRef.current = node as any;
            }}
            data={props.lines as CodeLine[]}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            extraData={listExtraData}
            testID={props.testID}
            style={VIRTUALIZED_LIST_STYLE}
            disableVirtualization={!virtualized}
            initialScrollIndex={scrollIndex >= 0 ? scrollIndex : undefined}
            getItemLayout={wrapLines ? undefined : getItemLayout}
            contentContainerStyle={contentContainerStyle}
            ListFooterComponent={listFooterComponent}
            onLayout={props.onLayout}
            onContentSizeChange={props.onContentSizeChange}
            onViewableItemsChanged={onViewableItemsChanged}
            onScroll={(event) => {
                nativeScrollOffset.current = event.nativeEvent.contentOffset.y;
                measureNativeReadingAnchor();
                props.onScroll?.(event);
            }}
            scrollEventThrottle={props.scrollEventThrottle}
            onScrollToIndexFailed={(info) => {
                const readingTarget = pendingReadingScroll.current?.index === info.index ? pendingReadingScroll.current : null;
                pendingReadingScroll.current = null;
                // Best-effort retry: FlatList can fail if measurement hasn't completed yet.
                try {
                    listRef.current?.scrollToOffset({
                        offset: info.averageItemLength * info.index - (readingTarget?.offset ?? 0),
                        animated: !readingTarget,
                    });
                } catch {
                    // ignore
                }
                setTimeout(() => {
                    try {
                        listRef.current?.scrollToIndex(readingTarget
                            ? { index: info.index, viewOffset: readingTarget.offset, animated: false }
                            : { index: info.index, viewPosition: 0.25, animated: true });
                    } catch {
                        // ignore
                    }
                }, 50);
            }}
        />
    );
}
