import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import { CodeLinesView } from '@/components/ui/code/view/CodeLinesView';
import { useCodeLinesSyntaxHighlighting } from '@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting';
import { useIntraLineWordDiffConfig } from '@/components/ui/code/diff/useIntraLineWordDiffConfig';
import { HorizontalOverflowScrollView } from '@/components/ui/scroll/HorizontalOverflowScrollView';
import { useSetting } from '@/sync/domains/state/storage';

import type { UnifiedDiffViewerProps } from '../diffViewerTypes';
import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';

import { mapCodeReadingAnchors } from '@/components/ui/code/model/mapCodeReadingAnchor';
import { collapseUnifiedDiffContext } from './collapseUnifiedDiffContext';
import { UnifiedDiffFoldToggleRow } from './UnifiedDiffFoldToggleRow';

export const HappierUnifiedDiffViewer = React.memo<UnifiedDiffViewerProps>((props) => {
    const wrapLines = props.wrapLines ?? true;
    const syntaxHighlighting = useCodeLinesSyntaxHighlighting(props.filePath ?? null);

    const foldingEnabled = useSetting('filesDiffFoldingEnabled') === true;
    const contextThreshold = useSetting('filesDiffFoldingContextThreshold') ?? 0;
    const contextRadius = useSetting('filesDiffFoldingContextRadius') ?? 0;
    const intraLineDiff = useIntraLineWordDiffConfig();

    const lines = React.useMemo(() => {
        if (props.precomputedLines) return props.precomputedLines;
        return buildCodeLinesFromUnifiedDiff({
            unifiedDiff: props.unifiedDiff,
            hideFilePrelude: true,
            intraLineDiff,
        });
    }, [intraLineDiff, props.precomputedLines, props.unifiedDiff]);

    const [expansion, setExpansion] = React.useState(() => ({
        filePath: props.filePath,
        lines,
        indices: new Set<number>(),
    }));
    // Reconcile before committing children so refreshed context never flashes closed.
    if (expansion.filePath !== props.filePath || expansion.lines !== lines) {
        const indices = expansion.filePath === props.filePath && expansion.indices.size > 0
            ? new Set(mapCodeReadingAnchors(
                expansion.lines.map((line) => `${line.kind}:${line.renderCodeText}`),
                lines.map((line) => `${line.kind}:${line.renderCodeText}`),
                [...expansion.indices],
            ).filter((index): index is number => index !== null))
            : new Set<number>();
        setExpansion({ filePath: props.filePath, lines, indices });
    }

    const canFold = foldingEnabled
        && !props.onPressAddComment
        && !props.renderAfterLine
        && !props.isCommentActive;

    const folded = React.useMemo(() => {
        if (!canFold) return { lines, regions: [] as const };
        return collapseUnifiedDiffContext({
            lines,
            contextThreshold,
            contextRadius,
            expandedLineIndices: expansion.indices,
        });
    }, [canFold, contextRadius, contextThreshold, expansion.indices, lines]);

    const foldRegionsByAfterLineId = React.useMemo(() => {
        const map = new Map<string, { hiddenStartIndex: number; hiddenCount: number }>();
        for (const region of folded.regions) {
            map.set(region.afterLineId, { hiddenStartIndex: region.hiddenStartIndex, hiddenCount: region.hiddenCount });
        }
        return map;
    }, [folded.regions]);

    const renderAfterLine = React.useCallback((line: CodeLine) => {
        const region = foldRegionsByAfterLineId.get(line.id) ?? null;
        if (!region) return null;
        return (
            <UnifiedDiffFoldToggleRow
                hiddenCount={region.hiddenCount}
                onPressExpand={() => {
                    setExpansion((prev) => {
                        const indices = new Set(prev.indices);
                        for (let index = region.hiddenStartIndex; index < region.hiddenStartIndex + region.hiddenCount; index += 1) {
                            indices.add(index);
                        }
                        return { ...prev, indices };
                    });
                }}
            />
        );
    }, [foldRegionsByAfterLineId]);

    const view = (
        <View style={props.virtualized ? styles.virtualizedBody : undefined}>
            <CodeLinesView
                lines={folded.lines}
                selectedLineIds={props.selectedLineIds}
                onPressLine={props.onPressLine}
                onPressLineRange={props.onPressLineRange}
                pressLineWhenNotSelectable={props.pressLineWhenNotSelectable}
                onPressAddComment={props.onPressAddComment}
                isCommentActive={props.isCommentActive}
                renderAfterLine={canFold ? renderAfterLine : props.renderAfterLine}
                showInactiveCommentAffordance={props.showInactiveCommentAffordance}
                contentPaddingHorizontal={props.contentPaddingHorizontal}
                contentPaddingVertical={props.contentPaddingVertical}
                wrapLines={wrapLines}
                virtualized={props.virtualized}
                showLineNumbers={props.showLineNumbers}
                showPrefix={props.showPrefix}
                scrollToLineId={props.scrollToLineId}
                onScrollToLine={props.onScrollToLine}
                externalScrollView={props.externalScrollView}
                highlightLineId={props.highlightLineId}
                highlightLineIds={props.highlightLineIds}
                syntaxHighlighting={syntaxHighlighting}
                testID={props.testID}
                onLayout={props.onLayout}
                onContentSizeChange={props.onContentSizeChange}
                onScroll={props.onScroll}
                scrollEventThrottle={props.scrollEventThrottle}
            />
        </View>
    );

    if (wrapLines) return view;

    return (
        <HorizontalOverflowScrollView
            showsHorizontalScrollIndicator={true}
            contentContainerStyle={{ flexGrow: 1 }}
        >
            {view}
        </HorizontalOverflowScrollView>
    );
});

const styles = StyleSheet.create({
    virtualizedBody: {
        flex: 1,
        minHeight: 0,
    },
});
