import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { buildCodeLinesFromTextDiff } from '@/components/ui/code/model/buildCodeLinesFromTextDiff';
import { CodeLinesView } from '@/components/ui/code/view/CodeLinesView';
import { useCodeLinesSyntaxHighlighting } from '@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting';
import { HorizontalOverflowScrollView } from '@/components/ui/scroll/HorizontalOverflowScrollView';
import type { TextDiffViewerProps } from '../diffViewerTypes';

export const HappierTextDiffViewer = React.memo<TextDiffViewerProps>((props) => {
    const wrapLines = props.wrapLines ?? true;
    const contextLines = props.contextLines ?? 3;
    const syntaxHighlighting = useCodeLinesSyntaxHighlighting(props.filePath ?? null);

    const lines = React.useMemo(() => {
        return buildCodeLinesFromTextDiff({
            oldText: props.oldText,
            newText: props.newText,
            contextLines,
        });
    }, [contextLines, props.newText, props.oldText]);

    const view = (
        <View style={props.virtualized ? styles.virtualizedBody : undefined}>
            <CodeLinesView
                lines={lines}
                selectedLineIds={props.selectedLineIds}
                onPressLine={props.onPressLine}
                onPressLineRange={props.onPressLineRange}
                pressLineWhenNotSelectable={props.pressLineWhenNotSelectable}
                onPressAddComment={props.onPressAddComment}
                isCommentActive={props.isCommentActive}
                renderAfterLine={props.renderAfterLine}
                showInactiveCommentAffordance={props.showInactiveCommentAffordance}
                contentPaddingHorizontal={props.contentPaddingHorizontal}
                contentPaddingVertical={props.contentPaddingVertical}
                wrapLines={wrapLines}
                virtualized={props.virtualized ?? false}
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
