import * as React from 'react';
import { FlatList, Platform, Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { FlashList } from '@/components/ui/lists/flashListCompat/FlashListCompat';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import type { FilesystemBrowserListProps } from './filesystemBrowserTypes';
import { Icon } from '@/components/ui/icons/Icon';

const FILESYSTEM_BROWSER_ESTIMATED_ITEM_SIZE = 38;

export const FilesystemBrowserList = React.memo(function FilesystemBrowserList(props: FilesystemBrowserListProps): React.ReactElement {
    const { theme } = useUnistyles();
    const showRootLoadingHeader = props.rootLoading && props.showInlineLoadingHeader !== false;
    const keyExtractor = React.useCallback((node: FilesystemBrowserListProps['nodes'][number]) => `${node.type}:${node.path}`, []);
    const renderItem = React.useCallback(({ item: node, index }: Readonly<{ item: FilesystemBrowserListProps['nodes'][number]; index: number }>) => (
        props.renderRow({ node, index, totalCount: props.nodes.length })
    ), [props.nodes.length, props.renderRow]);
    const listHeaderComponent = showRootLoadingHeader ? (
        <View
            style={{
                paddingHorizontal: 12,
                paddingVertical: 10,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
            }}
        >
            <ActivitySpinner size="small" color={theme.colors.text.secondary} />
            <Text style={{ fontSize: 12, color: theme.colors.text.secondary, ...Typography.default() }}>
                {props.loadingLabel}
            </Text>
        </View>
    ) : props.rootError ? (
        <View
            testID={props.listHeaderTestID}
            style={{
                paddingHorizontal: 12,
                paddingVertical: 10,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
            }}
        >
            <Icon name="warning-circle" size={16} color={theme.colors.text.secondary} />
            <Text style={{ fontSize: 12, color: theme.colors.text.secondary, ...Typography.default() }}>
                {props.inlineRetryLabel}
            </Text>
            <View style={{ flex: 1 }} />
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={props.inlineRetryLabel}
                onPress={() => {
                    void props.retryRoot();
                }}
                style={{ paddingHorizontal: 10, paddingVertical: 6 }}
            >
                <Text style={{ fontSize: 12, color: theme.colors.text.link, ...Typography.default('semiBold') }}>
                    {props.inlineRetryLabel}
                </Text>
            </Pressable>
        </View>
    ) : null;

    const sharedListProps = {
        ref: props.listRef,
        ...(Platform.OS === 'web' && props.treeRole ? { role: 'tree' as const } : {}),
        data: props.nodes,
        keyExtractor,
        style: props.style,
        contentContainerStyle: props.contentContainerStyle,
        extraData: props.extraData,
        ListHeaderComponent: listHeaderComponent,
        renderItem,
        initialNumToRender: props.initialNumToRender,
        maxToRenderPerBatch: props.maxToRenderPerBatch,
        windowSize: props.windowSize,
        removeClippedSubviews: props.removeClippedSubviews,
        onLayout: props.onLayout,
        onContentSizeChange: props.onContentSizeChange,
        onScroll: props.onScroll,
        onScrollToIndexFailed: props.onScrollToIndexFailed,
        scrollEventThrottle: props.scrollEventThrottle,
        getItemLayout: props.getItemLayout,
    } as const;

    if (Platform.OS !== 'web') {
        return (
            <FlashList
                {...sharedListProps}
                estimatedItemSize={FILESYSTEM_BROWSER_ESTIMATED_ITEM_SIZE}
            />
        );
    }

    return (
        <FlatList
            {...sharedListProps}
        />
    );
});
