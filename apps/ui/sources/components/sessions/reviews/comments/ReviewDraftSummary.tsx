import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { filterReviewCommentDraftsIncludedInPrompt } from '@/sync/domains/input/reviewComments/reviewCommentPrompt';
import { t } from '@/text';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';

export type ReviewDraftSummaryProps = Readonly<{
    enabled: boolean;
    drafts: readonly ReviewCommentDraft[];
    onGoToComposer: () => void;
}>;

export function ReviewDraftSummary(props: ReviewDraftSummaryProps) {
    const { theme } = useUnistyles();
    if (!props.enabled || props.drafts.length === 0) return null;
    const included = filterReviewCommentDraftsIncludedInPrompt(props.drafts).length;
    return (
        <View testID="review-drafts-summary" style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8 }}>
            <Text style={{ flexGrow: 1, flexShrink: 1, color: theme.colors.text.secondary }}>
                {t('files.reviewComments.modalSummary', { included, count: props.drafts.length })}
            </Text>
            <ToolbarButton
                testID="review-drafts-go-to-composer"
                label={t('files.reviewComments.goToComposer')}
                onPress={props.onGoToComposer}
                style={{ minHeight: 48 }}
            />
        </View>
    );
}
