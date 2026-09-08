import * as React from 'react';
import { Pressable, View } from 'react-native';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { ScmLogEntry } from '@happier-dev/protocol';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

type SourceControlOperationsHistorySectionProps = Readonly<{
    theme: any;
    historyIdentity: string;
    onCommitLayout?: (sha: string, y: number, height: number) => void;
    historyLoading: boolean;
    historyEntries: ScmLogEntry[];
    historyHasMore: boolean;
    onLoadMoreHistory: () => void;
    onOpenCommit: (sha: string) => void;
}>;

export function SourceControlOperationsHistorySection(props: SourceControlOperationsHistorySectionProps) {
    const { theme, historyLoading, historyEntries, historyHasMore, onLoadMoreHistory, onOpenCommit } = props;
    const DEFAULT_VISIBLE_COUNT = 5;
    const LOAD_MORE_STEP = 20;
    const [visibleCount, setVisibleCount] = React.useState(DEFAULT_VISIBLE_COUNT);

    const [historyContext, setHistoryContext] = React.useState({
        identity: props.historyIdentity,
        entries: historyEntries,
    });
    if (historyContext.identity !== props.historyIdentity) {
        setHistoryContext({ identity: props.historyIdentity, entries: historyEntries });
        setVisibleCount(DEFAULT_VISIBLE_COUNT);
    } else if (historyContext.entries !== historyEntries) {
        // Keep the oldest displayed commit visible when new commits arrive above it.
        const lastVisibleSha = historyContext.entries[Math.min(visibleCount, historyContext.entries.length) - 1]?.sha;
        const nextIndex = historyEntries.findIndex((entry) => entry.sha === lastVisibleSha);
        setHistoryContext({ identity: props.historyIdentity, entries: historyEntries });
        if (visibleCount > DEFAULT_VISIBLE_COUNT && nextIndex >= visibleCount) setVisibleCount(nextIndex + 1);
    }

    if (historyLoading && historyEntries.length === 0) {
        return <ActivitySpinner size="small" color={theme.colors.text.secondary} />;
    }

    if (historyEntries.length === 0) {
        return (
            <Text style={{ color: theme.colors.text.secondary, fontSize: 12, ...Typography.default() }}>
                {t('files.operationsHistory.noCommitsAvailable')}
            </Text>
        );
    }

    return (
        <View>
            <Text
                style={{
                    fontSize: 12,
                    color: theme.colors.text.secondary,
                    marginBottom: 6,
                    ...Typography.default('semiBold'),
                }}
            >
                {t('files.operationsHistory.recentCommits')}
            </Text>
            {historyEntries.slice(0, Math.min(historyEntries.length, visibleCount)).map((entry) => (
                <Pressable
                    key={entry.sha}
                    testID={`scm-commit-entry-${entry.sha}`}
                    onPress={() => onOpenCommit(entry.sha)}
                    onLayout={props.onCommitLayout ? (event) => {
                        const { y, height } = event.nativeEvent.layout;
                        props.onCommitLayout?.(entry.sha, y, height);
                    } : undefined}
                    style={(p) => ({
                        paddingVertical: 10,
                        paddingHorizontal: 10,
                        borderRadius: 12,
                        backgroundColor: p.pressed
                            ? (theme.colors.surface.inset ?? theme.colors.input.background)
                            : 'transparent',
                    })}
                >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                        <View
                            style={{
                                paddingHorizontal: 8,
                                paddingVertical: 6,
                                // A sha tag is a label, not a control: the canonical badge shape,
                                // background-only.
                                borderRadius: 8,
                                borderWidth: 0,
                                backgroundColor: theme.colors.state.neutral.background,
                            }}
                        >
                            <Text style={{ color: theme.colors.text.secondary, fontSize: 11, ...Typography.mono('semiBold') }}>
                                {entry.shortSha}
                            </Text>
                        </View>
                        <View style={{ flex: 1 }}>
                            <Text
                                style={{ color: theme.colors.text.primary, fontSize: 13, ...Typography.default('semiBold') }}
                                numberOfLines={1}
                            >
                                {entry.subject}
                            </Text>
                            <Text style={{ color: theme.colors.text.secondary, fontSize: 11, ...Typography.default() }}>
                                {new Date(entry.timestamp).toLocaleString()}
                            </Text>
                        </View>
                        <Icon name="caret-right" size={14} color={theme.colors.text.secondary} />
                    </View>
                </Pressable>
            ))}
            {(historyHasMore || visibleCount < historyEntries.length) && (
                <Pressable
                    disabled={historyLoading}
                    testID="scm-commit-load-more"
                    onPress={() => {
                        setVisibleCount((prev) => prev + LOAD_MORE_STEP);
                        if (historyHasMore) {
                            onLoadMoreHistory();
                        }
                    }}
                    style={(p) => ({
                        marginTop: 4,
                        paddingVertical: 10,
                        paddingHorizontal: 10,
                        borderRadius: 12,
                        borderWidth: 1,
                        borderColor: theme.colors.border.default,
                        backgroundColor: theme.colors.surface.inset ?? theme.colors.input.background,
                        opacity: historyLoading ? 0.6 : p.pressed ? 0.85 : 1,
                    })}
                >
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                        <Text style={{ color: theme.colors.text.link, fontSize: 12, ...Typography.default('semiBold') }}>
                            {historyLoading ? t('common.loading') : t('files.operationsHistory.loadMore')}
                        </Text>
                        <Icon name="caret-down" size={14} color={theme.colors.text.secondary} />
                    </View>
                </Pressable>
            )}
        </View>
    );
}
