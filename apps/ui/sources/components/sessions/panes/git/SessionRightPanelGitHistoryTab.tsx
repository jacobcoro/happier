import * as React from 'react';
import { Platform, ScrollView, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import type { ScmLogEntry } from '@happier-dev/protocol';

import { SourceControlOperationsHistorySection } from '@/components/sessions/files/SourceControlOperationsHistorySection';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';

// Row measurements own anchoring; browser CSS anchoring must not apply the same movement twice.
const historyScrollStyle = { flex: 1, ...(Platform.OS === 'web' ? { overflowAnchor: 'none' as const } : {}) };
const historyContentPadding = 12;

export type SessionRightPanelGitHistoryTabProps = Readonly<{
    theme: any;
    historyIdentity: string;
    historyLoading: boolean;
    historyEntries: ScmLogEntry[];
    historyHasMore: boolean;
    onLoadMoreHistory: () => void;
    onOpenCommit: (sha: string) => void;
}>;

export const SessionRightPanelGitHistoryTab = React.memo((props: SessionRightPanelGitHistoryTabProps) => {
    const scrollFades = useScrollEdgeFades({
        enabledEdges: { top: true, bottom: true },
        overflowThreshold: 1,
        edgeThreshold: 1,
    });

    const scrollRef = React.useRef<ScrollView>(null);
    const rowsRef = React.useRef(new Map<string, { y: number; height: number }>());
    const anchorRef = React.useRef<{ sha: string; y: number } | null>(null);
    const offsetRef = React.useRef(0);
    React.useLayoutEffect(() => {
        rowsRef.current.clear();
        anchorRef.current = null;
        offsetRef.current = 0;
        scrollRef.current?.scrollTo({ y: 0, animated: false });
    }, [props.historyIdentity]);
    const onScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        scrollFades.onScroll(event);
        const offset = event.nativeEvent.contentOffset.y;
        offsetRef.current = offset;
        anchorRef.current = null;
        if (offset <= 0) return;
        for (const [sha, row] of rowsRef.current) {
            if (row.y + historyContentPadding <= offset && row.y + historyContentPadding + row.height > offset) {
                anchorRef.current = { sha, y: row.y };
                break;
            }
        }
    }, [scrollFades.onScroll]);
    const onCommitLayout = React.useCallback((sha: string, y: number, height: number) => {
        rowsRef.current.set(sha, { y, height });
        const anchor = anchorRef.current;
        if (anchor?.sha !== sha || anchor.y === y) return;
        // Compensate only the viewed row's movement, not appended rows or a user's scroll.
        offsetRef.current = Math.max(0, offsetRef.current + y - anchor.y);
        anchorRef.current = { sha, y };
        scrollRef.current?.scrollTo({ y: offsetRef.current, animated: false });
    }, []);
    React.useEffect(() => {
        const shas = new Set(props.historyEntries.map((entry) => entry.sha));
        for (const sha of rowsRef.current.keys()) {
            if (!shas.has(sha)) rowsRef.current.delete(sha);
        }
        if (anchorRef.current && !shas.has(anchorRef.current.sha)) anchorRef.current = null;
    }, [props.historyEntries]);

    return (
        <View style={{ flex: 1, position: 'relative' }}>
            <ScrollView
                ref={scrollRef}
                testID="scm-history-scroll"
                style={historyScrollStyle}
                contentContainerStyle={{ padding: historyContentPadding, paddingBottom: 16 }}
                onLayout={scrollFades.onViewportLayout}
                onContentSizeChange={scrollFades.onContentSizeChange}
                onScroll={onScroll}
                scrollEventThrottle={16}
            >
                <SourceControlOperationsHistorySection
                    key={props.historyIdentity}
                    theme={props.theme}
                    onCommitLayout={onCommitLayout}
                    historyIdentity={props.historyIdentity}
                    historyLoading={props.historyLoading}
                    historyEntries={props.historyEntries}
                    historyHasMore={props.historyHasMore}
                    onLoadMoreHistory={props.onLoadMoreHistory}
                    onOpenCommit={props.onOpenCommit}
                />
            </ScrollView>
            <ScrollEdgeFades
                color={props.theme.colors.surface.base}
                size={18}
                edges={scrollFades.visibility}
            />
            <ScrollEdgeIndicators
                edges={scrollFades.visibility}
                color={props.theme.colors.text.secondary}
                size={14}
                opacity={0.35}
            />
        </View>
    );
});
