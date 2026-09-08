import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { ActivitySpinner, iconMatchedSpinnerSize } from '@/components/ui/feedback/ActivitySpinner';
import { IconAction } from '@/components/ui/buttons/IconAction';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';

import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

// One glyph size for the composer's action row, so its spinner and icons agree.
const COMPOSER_GLYPH_SIZE_PX = 16;

export type ScmCommitAdjacentPushAction = Readonly<{
    visible: boolean;
    disabled: boolean;
    busy: boolean;
    accessibilityLabel: string;
    onPress: () => void;
}>;

export type ScmCommitComposerCardProps = Readonly<{
    theme: any;
    commitActionLabel: string;
    draftMessage: string;
    onDraftMessageChange: (value: string) => void;
    busy: boolean;
    status: string | null;
    commitAllowed: boolean;
    commitBlockedMessage: string | null;
    onCommitFromMessage: (message: string) => void;
    selectionCount?: number;
    onClearSelection?: () => void;
    onSelectAllSelection?: () => void;
    /**
     * When true, the composer surfaces a "Select files to commit" affordance instead of
     * showing a per-row "+" on every changed file. Tapping it enters selection mode
     * (which reveals the row toggles and this selection summary). Defaults off so the
     * changed-files rows stay uncluttered and legible at narrow widths.
     */
    commitSelectionAvailable?: boolean;
    selectionModeActive?: boolean;
    onEnterSelectionMode?: () => void;
    onExitSelectionMode?: () => void;
    variant?: 'card' | 'railFooter';
    commitMessageGeneratorEnabled?: boolean;
    onGenerateCommitMessageSuggestion?: () => Promise<
        | { ok: true; message: string }
        | { ok: false; error: string }
    >;
    pushAction?: ScmCommitAdjacentPushAction;
}>;

function unwrapMarkdownCodeFence(value: string): string {
    const trimmed = value.trim();
    const match = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
    return match?.[1]?.trim() ?? trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeGeneratedCommitMessageSuggestion(value: string): string {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) return '';

    const unwrapped = unwrapMarkdownCodeFence(trimmed);
    try {
        const parsed: unknown = JSON.parse(unwrapped);
        if (!isRecord(parsed)) return unwrapped;

        const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
        if (message) return message;

        const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
        const body = typeof parsed.body === 'string' ? parsed.body.trim() : '';
        if (title && body) return `${title}\n\n${body}`;
        return title || body || unwrapped;
    } catch {
        return unwrapped;
    }
}

export const ScmCommitComposerCard = React.memo((props: ScmCommitComposerCardProps) => {
    const trimmedMessage = String(props.draftMessage ?? '').trim();
    const commitDisabled = props.busy || !props.commitAllowed || trimmedMessage.length === 0;
    const variant = props.variant ?? 'card';
    const generatorEnabled = props.commitMessageGeneratorEnabled === true && typeof props.onGenerateCommitMessageSuggestion === 'function';
    const [generating, setGenerating] = React.useState(false);
    const pushAction = props.pushAction?.visible === true ? props.pushAction : null;
    const pushDisabled = props.busy || pushAction?.disabled === true || pushAction?.busy === true;
    const commitButtonContentColor = commitDisabled
        ? props.theme.colors.text.secondary
        : props.theme.colors.button?.primary?.tint ?? props.theme.colors.surface.base;

    const onGenerate = React.useCallback(async () => {
        if (!generatorEnabled || !props.onGenerateCommitMessageSuggestion) return;
        if (props.busy || generating) return;
        setGenerating(true);
        try {
            const res = await props.onGenerateCommitMessageSuggestion();
            if (res.ok) {
                props.onDraftMessageChange(normalizeGeneratedCommitMessageSuggestion(res.message));
            } else {
                Modal.alert(t('common.error'), res.error);
            }
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : String(error));
        } finally {
            setGenerating(false);
        }
    }, [generatorEnabled, generating, props]);

    return (
        <View
            style={{
                ...(variant === 'card'
                    ? {
                        marginHorizontal: 12,
                        marginTop: 12,
                        marginBottom: 12,
                        padding: 12,
                        borderRadius: 14,
                        borderWidth: 1,
                        borderColor: props.theme.colors.border.default,
                    }
                    : {
                        paddingHorizontal: 12,
                        paddingTop: 10,
                        paddingBottom: 12,
                    }),
                backgroundColor: variant === 'card' ? props.theme.colors.surface.base : 'transparent',
            }}
        >
            {props.commitSelectionAvailable ? (
                props.selectionModeActive ? (
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
                        <Text
                            testID="scm-commit-selection-summary"
                            style={{ flexGrow: 1, fontSize: 12, color: props.theme.colors.text.secondary, ...Typography.default('semiBold') }}
                        >
                            {t('files.sourceControlOperations.selection', { count: props.selectionCount ?? 0 })}
                        </Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            {props.onSelectAllSelection ? (
                                <ToolbarButton
                                    label={t('common.all')}
                                    onPress={props.onSelectAllSelection}
                                />
                            ) : null}

                            {((props.selectionCount ?? 0) > 0 && props.onClearSelection) ? (
                                <ToolbarButton
                                    label={t('files.sourceControlOperations.clear')}
                                    accessibilityLabel={t('files.fileActions.clearSelection')}
                                    onPress={props.onClearSelection}
                                />
                            ) : null}

                            {((props.selectionCount ?? 0) === 0 && props.onExitSelectionMode) ? (
                                <ToolbarButton
                                    testID="scm-commit-exit-selection"
                                    label={t('common.done')}
                                    onPress={props.onExitSelectionMode}
                                />
                            ) : null}
                        </View>
                    </View>
                ) : (
                    <ToolbarButton
                        testID="scm-commit-enter-selection"
                        label={t('files.fileActions.selectFilesToCommit')}
                        icon={<Icon name="check-circle" size={14} color={props.theme.colors.text.secondary} />}
                        onPress={props.onEnterSelectionMode}
                        style={{ alignSelf: 'flex-start', marginBottom: 10 }}
                    />
                )
            ) : null}
            {props.status && !props.busy ? (
                <Text style={{ marginBottom: 8, fontSize: 11, color: props.theme.colors.text.secondary, ...Typography.default() }}>
                    {props.status}
                </Text>
            ) : null}
            <View
                style={{
                    borderRadius: 12,
                    borderWidth: variant === 'card' ? 1 : 0,
                    borderColor: props.theme.colors.border.default,
                    backgroundColor:
                        variant === 'card'
                            ? (props.theme.colors.surface.inset ?? props.theme.colors.surface.base)
                            : 'transparent',
                    paddingHorizontal: 10,
                    paddingVertical: Platform.OS === 'web' ? 10 : 8,
                }}
            >
                <TextInput
                    testID="scm-commit-message"
                    value={props.draftMessage}
                    onChangeText={props.onDraftMessageChange}
                    editable={!props.busy}
                    multiline
                    placeholder={t('files.commitMessageEditor.placeholder')}
                    placeholderTextColor={props.theme.colors.input.placeholder}
                    style={{
                        fontSize: 13,
                        color: props.theme.colors.text.primary,
                        minHeight: 44,
                        maxHeight: 96,
                        padding: 0,
                        textAlignVertical: 'top' as any,
                        ...(Platform.select({ web: { outlineStyle: 'none' as any } }) as any),
                    }}
                />
            </View>

            {!props.commitAllowed && props.commitBlockedMessage ? (
                <Text style={{ marginTop: 8, fontSize: 11, color: props.theme.colors.text.secondary, ...Typography.default() }}>
                    {props.commitBlockedMessage}
                </Text>
            ) : null}

            <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
                {generatorEnabled ? (
                    <IconAction
                        size="lg"
                        accessibilityLabel={t('files.commitMessageEditor.generate')}
                        disabled={props.busy || generating}
                        onPress={onGenerate}
                    >
                        {generating ? (
                            <ActivitySpinner
                                size={iconMatchedSpinnerSize(COMPOSER_GLYPH_SIZE_PX)}
                                color={props.theme.colors.text.secondary}
                            />
                        ) : (
                            <Icon
                                name="sparkle"
                                size={COMPOSER_GLYPH_SIZE_PX}
                                color={props.theme.colors.text.secondary}
                            />
                        )}
                    </IconAction>
                ) : null}
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={props.commitActionLabel}
                    accessibilityState={{ busy: props.busy, disabled: commitDisabled }}
                    disabled={commitDisabled}
                    onPress={() => props.onCommitFromMessage(trimmedMessage)}
                    testID="scm-commit-submit"
                    style={({ pressed }) => ({
                        flex: 1,
                        height: 38,
                        borderRadius: 12,
                        // Enabled, the fill carries the button; an outline in the same colour on top
                        // of it is the same statement twice. Disabled, the fill drops away, so the
                        // hairline is what keeps it readable as a control.
                        borderWidth: commitDisabled ? 1 : 0,
                        borderColor: props.theme.colors.border.subtle,
                        backgroundColor: commitDisabled ? (props.theme.colors.surface.inset ?? props.theme.colors.surface.base) : props.theme.colors.state.success.foreground,
                        alignItems: 'center',
                        justifyContent: 'center',
                        opacity: commitDisabled ? 0.55 : pressed ? 0.85 : 1,
                    })}
                >
                    {props.busy ? (
                        <ActivitySpinner size={iconMatchedSpinnerSize(COMPOSER_GLYPH_SIZE_PX)} color={commitButtonContentColor} />
                    ) : (
                        <Text style={{ fontSize: 12, color: commitButtonContentColor, ...Typography.default('semiBold') }}>
                            {props.commitActionLabel}
                        </Text>
                    )}
                </Pressable>
                {pushAction ? (
                    <IconAction
                        size="lg"
                        accessibilityLabel={pushAction.accessibilityLabel}
                        disabled={pushDisabled}
                        onPress={pushAction.onPress}
                        testID="scm-commit-adjacent-push"
                    >
                        {pushAction.busy ? (
                            <ActivitySpinner
                                size={iconMatchedSpinnerSize(COMPOSER_GLYPH_SIZE_PX)}
                                color={props.theme.colors.text.secondary}
                            />
                        ) : (
                            <Icon
                                name="arrow-circle-up"
                                size={COMPOSER_GLYPH_SIZE_PX}
                                color={props.theme.colors.text.secondary}
                            />
                        )}
                    </IconAction>
                ) : null}
            </View>
        </View>
    );
});
