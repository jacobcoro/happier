import * as React from 'react';
import { Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { IconAction } from '@/components/ui/buttons/IconAction';
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';
import type { ChangedFilesReviewDiffStateSource } from './ChangedFilesReviewDiffStore';
import { useReviewDiffHunkNavigation } from './useReviewDiffHunkNavigation';

export type ChangedFilesReviewLineTarget = Readonly<{ filePath: string; lineId: string }>;

function ChangedFilesReviewHunkNavigation(props: Readonly<{
    filePath: string;
    diffStateSource: ChangedFilesReviewDiffStateSource;
    onFocusLine: (target: ChangedFilesReviewLineTarget | null) => void;
}>) {
    const { theme } = useUnistyles();
    const state = React.useSyncExternalStore(
        React.useCallback((listener) => props.diffStateSource.subscribe(props.filePath, listener), [props.diffStateSource, props.filePath]),
        React.useCallback(() => props.diffStateSource.getDiffState(props.filePath), [props.diffStateSource, props.filePath]),
        React.useCallback(() => props.diffStateSource.getDiffState(props.filePath), [props.diffStateSource, props.filePath]),
    );
    const navigation = useReviewDiffHunkNavigation(state.diff);
    React.useEffect(() => { props.onFocusLine(null); }, [props.filePath, props.onFocusLine, state.diff]);
    const move = (direction: -1 | 1) => {
        const lineId = direction === 1 ? navigation.next() : navigation.previous();
        if (lineId) props.onFocusLine({ filePath: props.filePath, lineId });
    };
    if (navigation.count < 2) return null;
    return (
        <>
            <IconAction
                testID="scm-review-previous-hunk"
                accessibilityLabel={t('files.reviewPreviousHunk')}
                disabled={!navigation.canPrevious}
                onPress={() => move(-1)}
                size="sm"
                style={Platform.OS === 'web' ? undefined : { width: 48, height: 48 }}
            >
                <Icon name="caret-up" size={16} color={theme.colors.text.secondary} />
            </IconAction>
            <IconAction
                testID="scm-review-next-hunk"
                accessibilityLabel={t('files.reviewNextHunk')}
                disabled={!navigation.canNext}
                onPress={() => move(1)}
                size="sm"
                style={Platform.OS === 'web' ? undefined : { width: 48, height: 48 }}
            >
                <Icon name="caret-down" size={16} color={theme.colors.text.secondary} />
            </IconAction>
        </>
    );
}

export function ChangedFilesReviewNavigation(props: Readonly<{
    paths: readonly string[];
    activePath: string | null;
    onFocusPath: (path: string) => void;
    diffStateSource: ChangedFilesReviewDiffStateSource;
    onFocusLine: (target: ChangedFilesReviewLineTarget | null) => void;
}>) {
    const { theme } = useUnistyles();
    if (props.paths.length === 0) return null;
    const index = Math.max(0, props.activePath ? props.paths.indexOf(props.activePath) : 0);
    const move = (direction: -1 | 1) => {
        const path = props.paths[index + direction];
        if (path) props.onFocusPath(path);
    };
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
            {props.paths.length > 1 ? (
                <IconAction
                    testID="scm-review-previous-file"
                    accessibilityLabel={t('files.reviewPreviousFile')}
                    disabled={index === 0}
                    onPress={() => move(-1)}
                    size="sm"
                    style={Platform.OS === 'web' ? undefined : { width: 48, height: 48 }}
                >
                    <Icon name="caret-left" size={16} color={theme.colors.text.secondary} />
                </IconAction>
            ) : null}
            {props.paths.length > 1 ? (
                <IconAction
                    testID="scm-review-next-file"
                    accessibilityLabel={t('files.reviewNextFile')}
                    disabled={index === props.paths.length - 1}
                    onPress={() => move(1)}
                    size="sm"
                    style={Platform.OS === 'web' ? undefined : { width: 48, height: 48 }}
                >
                    <Icon name="caret-right" size={16} color={theme.colors.text.secondary} />
                </IconAction>
            ) : null}
            <ChangedFilesReviewHunkNavigation
                key={props.paths[index]}
                filePath={props.paths[index]}
                diffStateSource={props.diffStateSource}
                onFocusLine={props.onFocusLine}
            />
        </View>
    );
}
