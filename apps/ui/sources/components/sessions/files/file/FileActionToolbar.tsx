import * as React from 'react';
import { Platform, Pressable, View, type LayoutChangeEvent } from 'react-native';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { HorizontalScrollableRow } from '@/components/ui/scroll/HorizontalScrollableRow';
import { Text } from '@/components/ui/text/Text';
import { InlineRepoPathLabel } from '@/components/ui/path/InlineRepoPathLabel';
import { PressableSurface } from '@/components/ui/interaction/PressableSurface';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { ScmProjectInFlightOperation } from '@/sync/runtime/orchestration/projectManager';
import type { MarkdownEditMode } from '@/components/ui/markdown/editor/markdownEditorTypes';
import type { MarkdownRichIneligibleReason } from '@/components/ui/markdown/editor/core/eligibility/markdownRichEligibility';
import { resolveMarkdownRichDisabledReasonCopy } from '@/components/ui/markdown/editor/core/eligibility/markdownRichDisabledReasonCopy';
import { StyleSheet as RNStyleSheet } from 'react-native';
import { IconAction } from '@/components/ui/buttons/IconAction';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { WrapLinesToggleButton } from '@/components/ui/code/WrapLinesToggleButton';

export type FileDisplayMode = 'file' | 'diff' | 'markdown';
export type FileDiffMode = 'included' | 'pending' | 'both';

const selectionActionStyle = { minHeight: Platform.select({ ios: 44, android: 48, default: 34 }) };

const FILE_ACTION_TOOLBAR_COMPACT_WIDTH = 520;
const FILE_ACTION_TOOLBAR_COMPACT_HORIZONTAL_PADDING = 12;
const FILE_ACTION_TOOLBAR_DEFAULT_HORIZONTAL_PADDING = 16;
const FILE_ACTION_TOOLBAR_COMPACT_GAP = 6;
const FILE_ACTION_TOOLBAR_DEFAULT_GAP = 8;

type FileActionToolbarProps = {
    theme: any;
    fileName?: string;
    filePathDir?: string;
    rightElement?: React.ReactNode;
    displayMode: FileDisplayMode;
    onDisplayMode: (mode: FileDisplayMode) => void;
    showDiffToggle?: boolean;
    showFileToggle?: boolean;
    showMarkdownToggle?: boolean;
    showWrapLinesToggle?: boolean;
    diffMode: FileDiffMode;
    onDiffMode: (mode: FileDiffMode) => void;
    hasPendingDelta: boolean;
    hasIncludedDelta: boolean;
    isUntrackedFile?: boolean;
    scmWriteEnabled: boolean;
    includeExcludeEnabled: boolean;
    virtualSelectionEnabled: boolean;
    isSelectedForCommit: boolean;
    lineSelectionEnabled: boolean;
    lineSelectionCanStart?: boolean;
    lineSelectionActive?: boolean;
    reviewCommentsEnabled?: boolean;
    commentModeActive?: boolean;
    selectedLineCount: number;
    isApplyingStage: boolean;
    inFlightScmOperation: ScmProjectInFlightOperation | null;
    onStageFile: () => void;
    onUnstageFile: () => void;
    onApplySelectedLines: () => void;
    onClearSelection: () => void;
    onStartLineSelection?: () => void;
    onToggleCommentMode?: (active: boolean) => void;
    fileEditorEnabled?: boolean;
    isEditingFile?: boolean;
    fileEditorDirty?: boolean;
    fileEditorBusy?: boolean;
    onStartEditingFile?: () => void;
    onCancelEditingFile?: () => void;
    onSaveEditingFile?: () => void;
    /** Raw<->Rich toggle (Lane I / I3): only shown for an editable markdown file. */
    showMarkdownEditToggle?: boolean;
    markdownEditMode?: MarkdownEditMode;
    onMarkdownEditMode?: (mode: MarkdownEditMode) => void;
    /**
     * Authoritative rich-eligibility from the edit-mode hook (N2). Passed through
     * explicitly rather than inferred from `markdownRichDisabledReason`, so the
     * toggle never has to second-guess the single source of truth.
     */
    markdownRichEligible?: boolean;
    /** When set, rich is unavailable; the reason is surfaced inline by the toggle. */
    markdownRichDisabledReason?: MarkdownRichIneligibleReason;
};

export function FileActionToolbar(props: FileActionToolbarProps) {
    const {
        theme,
        fileName,
        filePathDir,
        rightElement,
        displayMode,
        onDisplayMode,
        showDiffToggle,
        showFileToggle,
        showMarkdownToggle,
        showWrapLinesToggle,
        diffMode,
        onDiffMode,
        hasPendingDelta,
        hasIncludedDelta,
        isUntrackedFile,
        scmWriteEnabled,
        includeExcludeEnabled,
        virtualSelectionEnabled,
        isSelectedForCommit,
        lineSelectionEnabled,
        lineSelectionCanStart,
        lineSelectionActive,
        reviewCommentsEnabled,
        commentModeActive,
        selectedLineCount,
        isApplyingStage,
        inFlightScmOperation,
        onStageFile,
        onUnstageFile,
        onApplySelectedLines,
        onClearSelection,
        onStartLineSelection,
        onToggleCommentMode,
        fileEditorEnabled,
        isEditingFile,
        fileEditorDirty,
        fileEditorBusy,
        onStartEditingFile,
        onCancelEditingFile,
        onSaveEditingFile,
        showMarkdownEditToggle,
        markdownEditMode,
        onMarkdownEditMode,
        markdownRichEligible,
        markdownRichDisabledReason,
    } = props;

    const actionBusy = isApplyingStage || Boolean(inFlightScmOperation);
    const canIncludeFile = hasPendingDelta || isUntrackedFile === true;
    const canUseSelectionActions = includeExcludeEnabled || virtualSelectionEnabled;
    const canIncludeFileInSelection = virtualSelectionEnabled ? canIncludeFile && !isSelectedForCommit : canIncludeFile;
    const canRemoveFromSelection = virtualSelectionEnabled ? isSelectedForCommit : hasIncludedDelta;
    const showFileEditorActions = fileEditorEnabled === true;
    const shouldShowDiffToggle = showDiffToggle !== false;
    const shouldShowFileToggle = showFileToggle !== false;
    const shouldShowMarkdownToggle = showMarkdownToggle === true;
    const displayToggleCount = (shouldShowDiffToggle ? 1 : 0)
        + (shouldShowFileToggle ? 1 : 0)
        + (shouldShowMarkdownToggle ? 1 : 0);
    const shouldShowDisplayToggles = displayToggleCount > 1;
    // While editing a markdown file, the view-mode dropdown is REPURPOSED to pick
    // the editing mode (Raw source vs Rich WYSIWYG): you cannot change the view
    // (file/diff/markdown) mid-edit, so one context-dependent control replaces the
    // old separate segmented Raw/Rich toggle. Editing always happens in the 'file'
    // display, so this is the single condition that flips the dropdown's purpose.
    const isMarkdownEditModeMenu = showFileEditorActions
        && isEditingFile === true
        && displayMode === 'file'
        && showMarkdownEditToggle === true
        && onMarkdownEditMode != null;
    const [toolbarWidth, setToolbarWidth] = React.useState<number | null>(null);
    const [displayMenuOpen, setDisplayMenuOpen] = React.useState(false);
    const [diffAreaMenuOpen, setDiffAreaMenuOpen] = React.useState(false);
    const stageLabel = virtualSelectionEnabled ? t('files.fileActions.selectEntireFileForCommit') : t('files.fileActions.stageFile');
    const unstageLabel = virtualSelectionEnabled ? t('files.fileActions.removeFromCommitSelection') : t('files.fileActions.unstageFile');
    const commandIconSize = 14;
    const isLineSelectionActive = lineSelectionActive === true || selectedLineCount > 0;
    const canStartLineSelection = lineSelectionCanStart === true || lineSelectionEnabled;
    const isCommentModeActive = commentModeActive === true;
    const hasSelectedLines = isLineSelectionActive && lineSelectionEnabled && selectedLineCount > 0;
    const selectedLineActionIsRemoval = !virtualSelectionEnabled && diffMode === 'included';
    const selectedLineActionColor = selectedLineActionIsRemoval ? theme.colors.state.neutral.foreground : theme.colors.state.success.foreground;
    const selectedLineActionLabel = virtualSelectionEnabled
        ? t('files.fileActions.selectedLines.selectLinesForCommit')
        : selectedLineActionIsRemoval
            ? t('files.fileActions.selectedLines.unstageSelectedLines')
            : t('files.fileActions.selectedLines.stageSelectedLines');
    const pathDir = typeof filePathDir === 'string' ? filePathDir.trim().replace(/\/+$/, '') : '';
    const pathName = typeof fileName === 'string' ? fileName.trim() : '';
    const pathLabel = pathDir && pathName
        ? `${pathDir}/${pathName}`
        : pathName || pathDir || null;
    const useCompactLayout = toolbarWidth !== null && toolbarWidth < FILE_ACTION_TOOLBAR_COMPACT_WIDTH;
    const useCompactSelectedLineActions = useCompactLayout && hasSelectedLines;
    const toolbarHorizontalPadding = useCompactLayout
        ? FILE_ACTION_TOOLBAR_COMPACT_HORIZONTAL_PADDING
        : FILE_ACTION_TOOLBAR_DEFAULT_HORIZONTAL_PADDING;
    const actionGap = useCompactLayout ? FILE_ACTION_TOOLBAR_COMPACT_GAP : FILE_ACTION_TOOLBAR_DEFAULT_GAP;

    const onToolbarLayout = React.useCallback((event: LayoutChangeEvent) => {
        const width = Number(event.nativeEvent.layout.width);
        if (!Number.isFinite(width) || width <= 0) return;
        setToolbarWidth((current) => current === width ? current : width);
    }, []);

    // Dropdown triggers retain their popover anchor while matching the toolbar buttons.
    const chipStyle = (active: boolean) => ({
        minHeight: 34,
        paddingVertical: 5,
        paddingHorizontal: 10,
        borderRadius: 8,
        backgroundColor: active ? theme.colors.surface.pressed : theme.colors.surface.base,
        borderWidth: RNStyleSheet.hairlineWidth,
        borderColor: theme.colors.border.subtle,
        alignItems: 'center',
        justifyContent: 'center',
    }) as const;

    const displayModeItems = React.useMemo<DropdownMenuItem[]>(() => {
        const items: DropdownMenuItem[] = [];
        if (shouldShowDiffToggle) {
            items.push({
                id: 'diff',
                title: t('files.diff'),
                icon: <Icon name="git-diff" size={commandIconSize} color={theme.colors.text.secondary} />,
            });
        }
        if (shouldShowFileToggle) {
            items.push({
                id: 'file',
                title: t('files.file'),
                icon: <Icon name="file" size={commandIconSize} color={theme.colors.text.secondary} />,
            });
        }
        if (shouldShowMarkdownToggle) {
            items.push({
                id: 'markdown',
                title: t('files.markdown'),
                icon: <Icon name="markdown-logo" size={commandIconSize} color={theme.colors.text.secondary} />,
            });
        }
        return items;
    }, [commandIconSize, shouldShowDiffToggle, shouldShowFileToggle, shouldShowMarkdownToggle, theme.colors.text.secondary]);

    // Edit-mode options shown in the repurposed dropdown while editing markdown.
    // Rich is disabled (with the reason as a subtitle) when the file is ineligible.
    const markdownEditModeItems = React.useMemo<DropdownMenuItem[]>(() => {
        const richDisabled = markdownRichEligible !== true;
        return [
            {
                id: 'raw',
                title: t('settingsSourceControl.markdownEditMode.options.raw.title'),
                icon: <Icon name="code" size={commandIconSize} color={theme.colors.text.secondary} />,
            },
            {
                id: 'rich',
                title: t('settingsSourceControl.markdownEditMode.options.rich.title'),
                icon: <Icon name="markdown-logo" size={commandIconSize} color={theme.colors.text.secondary} />,
                disabled: richDisabled,
                subtitle: richDisabled ? resolveMarkdownRichDisabledReasonCopy(markdownRichDisabledReason) : undefined,
            },
        ];
    }, [commandIconSize, markdownRichEligible, markdownRichDisabledReason, theme.colors.text.secondary]);

    const diffAreaItems = React.useMemo<DropdownMenuItem[]>(() => {
        const items: DropdownMenuItem[] = [];
        if (hasPendingDelta) {
            items.push({
                id: 'pending',
                title: t('files.diffModes.pending'),
                icon: <Icon name="clock" size={commandIconSize} color={theme.colors.text.secondary} />,
            });
        }
        if (hasIncludedDelta) {
            items.push({
                id: 'included',
                title: t('files.diffModes.included'),
                icon: <Icon name="list-checks" size={commandIconSize} color={theme.colors.text.secondary} />,
            });
        }
        if (hasIncludedDelta && hasPendingDelta) {
            items.push({
                id: 'both',
                title: t('files.diffModes.combined'),
                icon: <Icon name="git-diff" size={commandIconSize} color={theme.colors.text.secondary} />,
            });
        }
        return items;
    }, [commandIconSize, hasIncludedDelta, hasPendingDelta, theme.colors.text.secondary]);

    const selectedDisplayLabel = displayMode === 'diff'
        ? t('files.diff')
        : displayMode === 'markdown'
            ? t('files.markdown')
            : t('files.file');
    const selectedDisplayIconName: IconName = displayMode === 'diff'
        ? 'git-diff'
        : displayMode === 'markdown'
            ? 'markdown-logo'
            : 'file';
    // Reflect the EFFECTIVE mode (what's actually rendered), not the stored
    // preference: a 'rich' preference on an INELIGIBLE file renders Raw, so the
    // dropdown trigger + selection must read "Raw" (the disabled Rich option + its
    // reason explain why). Showing "Rich" while raw is rendered is misleading.
    const effectiveMarkdownEditMode = markdownEditMode === 'rich' && markdownRichEligible === true ? 'rich' : 'raw';
    const selectedMarkdownEditModeLabel = effectiveMarkdownEditMode === 'rich'
        ? t('settingsSourceControl.markdownEditMode.options.rich.title')
        : t('settingsSourceControl.markdownEditMode.options.raw.title');
    const selectedMarkdownEditModeIconName: IconName = effectiveMarkdownEditMode === 'rich' ? 'markdown-logo' : 'code';
    const selectedDiffAreaLabel = diffAreaItems.find((item) => item.id === diffMode)?.title
        ?? (diffMode === 'included'
            ? t('files.diffModes.included')
            : diffMode === 'both'
                ? t('files.diffModes.combined')
                : t('files.diffModes.pending'));

    const renderDropdownTrigger = React.useCallback((input: Readonly<{
        label: string;
        icon: React.ReactNode;
        testID: string;
        selected?: boolean;
        toggle: () => void;
    }>) => (
        <Pressable
            onPress={input.toggle}
            testID={input.testID}
            style={chipStyle(input.selected === true)}
            accessibilityRole="button"
        >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {input.icon}
                <Text
                    style={{
                        fontSize: 13,
                        fontWeight: '600',
                        color: theme.colors.text.primary,
                        ...Typography.default(),
                    }}
                    numberOfLines={1}
                >
                    {input.label}
                </Text>
                <Icon name="caret-down" size={14} color={theme.colors.text.secondary} />
            </View>
        </Pressable>
    ), [chipStyle, theme.colors.text.primary, theme.colors.text.secondary]);

    const pathElement = pathLabel ? (
        <PressableSurface
            testID="file-details-path"
            accessibilityRole="text"
            accessibilityLabel={pathLabel}
            webTooltip={pathLabel}
            style={{ flexBasis: '32%', flexShrink: 0, minWidth: 0, minHeight: 32, justifyContent: 'center' }}
        >
            <InlineRepoPathLabel
                fullPath={pathLabel}
                preferNameOverPath
                alignForRootFiles={false}
                pathTextStyle={{ fontSize: 12, color: theme.colors.text.secondary, ...(Typography.mono ? Typography.mono() : Typography.default()) }}
                nameTextStyle={{ fontSize: 12, color: theme.colors.text.primary, ...(Typography.mono ? Typography.mono() : Typography.default()) }}
            />
        </PressableSurface>
    ) : null;

    const viewActionsElement = (
        <View
            testID="file-details-view-actions"
            style={{
                flexDirection: 'row',
                flexWrap: 'nowrap',
                alignItems: 'center',
                gap: actionGap,
                flexShrink: 0,
            }}
        >
            {isMarkdownEditModeMenu ? (
                <DropdownMenu
                    open={displayMenuOpen}
                    onOpenChange={setDisplayMenuOpen}
                    items={markdownEditModeItems}
                    selectedId={effectiveMarkdownEditMode}
                    onSelect={(itemId) => {
                        if (itemId === 'raw' || itemId === 'rich') {
                            onMarkdownEditMode?.(itemId);
                        }
                    }}
                    matchTriggerWidth={false}
                    maxWidthCap={260}
                    placement="bottom"
                    popoverAnchorAlign="start"
                    trigger={({ toggle }) => renderDropdownTrigger({
                        label: selectedMarkdownEditModeLabel,
                        icon: <Icon name={selectedMarkdownEditModeIconName} size={commandIconSize} color={theme.colors.text.secondary} />,
                        selected: true,
                        testID: 'markdown-edit-mode-menu',
                        toggle,
                    })}
                />
            ) : shouldShowDisplayToggles ? (
                <DropdownMenu
                    open={displayMenuOpen}
                    onOpenChange={setDisplayMenuOpen}
                    items={displayModeItems}
                    selectedId={displayMode}
                    onSelect={(itemId) => {
                        if (itemId === 'diff' || itemId === 'file' || itemId === 'markdown') {
                            onDisplayMode(itemId);
                        }
                    }}
                    matchTriggerWidth={false}
                    maxWidthCap={220}
                    placement="bottom"
                    popoverAnchorAlign="start"
                    trigger={({ toggle }) => renderDropdownTrigger({
                        label: selectedDisplayLabel,
                        icon: <Icon name={selectedDisplayIconName} size={commandIconSize} color={theme.colors.text.secondary} />,
                        selected: true,
                        testID: 'file-details-view-mode-menu',
                        toggle,
                    })}
                />
            ) : null}

            {showWrapLinesToggle === true ? <WrapLinesToggleButton /> : null}

            {showFileEditorActions && !isEditingFile && onStartEditingFile ? (
                <IconAction
                    onPress={() => {
                        onDisplayMode('file');
                        onStartEditingFile();
                    }}
                    testID="file-details-edit"
                    accessibilityLabel={t('common.edit')}
                >
                    <Icon name="pencil" size={commandIconSize} color={theme.colors.text.primary} />
                </IconAction>
            ) : null}

            {reviewCommentsEnabled === true && onToggleCommentMode ? (
                <IconAction
                    onPress={() => onToggleCommentMode(!isCommentModeActive)}
                    testID="file-details-comment-mode"
                    active={isCommentModeActive}
                    accessibilityLabel={t('files.reviewComments.addCommentA11y')}
                >
                    <Icon
                        name="chats-circle"
                        size={commandIconSize}
                        color={isCommentModeActive ? theme.colors.text.primary : theme.colors.text.secondary}
                    />
                </IconAction>
            ) : null}

            {showFileEditorActions && displayMode === 'file' && isEditingFile ? (
                <>
                    <Pressable
                        disabled={Boolean(fileEditorBusy) || !fileEditorDirty}
                        onPress={onSaveEditingFile}
                        testID="file-details-save"
                        style={{
                            paddingHorizontal: 12,
                            paddingVertical: 8,
                            borderRadius: 10,
                            backgroundColor: theme.colors.text.link,
                            opacity: Boolean(fileEditorBusy) || !fileEditorDirty ? 0.6 : 1,
                        }}
                    >
                        <Text style={{ color: 'white', fontSize: 13, ...Typography.default('semiBold') }}>
                            {t('common.save')}
                        </Text>
                    </Pressable>
                    <ToolbarButton
                        onPress={onCancelEditingFile}
                        testID="file-details-cancel"
                        size="md"
                        label={t('common.cancel')}
                    />
                    {/* Raw<->Rich selection now lives in the repurposed view-mode dropdown
                        above (see `isMarkdownEditModeMenu`); no separate toggle here. */}
                </>
            ) : null}

            {diffAreaItems.length > 1 ? (
                <DropdownMenu
                    open={diffAreaMenuOpen}
                    onOpenChange={setDiffAreaMenuOpen}
                    items={diffAreaItems}
                    selectedId={diffMode}
                    onSelect={(itemId) => {
                        if (itemId === 'pending' || itemId === 'included' || itemId === 'both') {
                            onDiffMode(itemId);
                        }
                    }}
                    matchTriggerWidth={false}
                    maxWidthCap={240}
                    placement="bottom"
                    popoverAnchorAlign="start"
                    trigger={({ toggle }) => renderDropdownTrigger({
                        label: selectedDiffAreaLabel,
                        icon: <Icon name="clock" size={commandIconSize} color={theme.colors.text.secondary} />,
                        selected: true,
                        testID: 'file-details-diff-area-menu',
                        toggle,
                    })}
                />
            ) : null}
        </View>
    );

    const changeActionsElement = (
        <View
            testID="file-details-change-actions"
            style={{
                flexDirection: 'row',
                flexWrap: 'nowrap',
                alignItems: 'center',
                justifyContent: 'flex-start',
                gap: actionGap,
                flexShrink: 0,
            }}
        >
            {scmWriteEnabled && canUseSelectionActions && canIncludeFileInSelection && !hasSelectedLines && (
                <IconAction
                    disabled={actionBusy}
                    onPress={onStageFile}
                    testID="file-details-stage-file"
                    accessibilityLabel={stageLabel}
                    style={{ ...selectionActionStyle, minWidth: selectionActionStyle.minHeight, flexShrink: 0 }}
                >
                    <Icon name="plus" size={commandIconSize} color={theme.colors.text.secondary} />
                </IconAction>
            )}

            {scmWriteEnabled && canUseSelectionActions && canStartLineSelection && onStartLineSelection && !isLineSelectionActive && (
                <ToolbarButton
                    disabled={actionBusy}
                    onPress={onStartLineSelection}
                    testID="file-details-select-lines"
                    label={t('files.fileActions.selectLines')}
                    size="md"
                    style={selectionActionStyle}
                />
            )}

            {isLineSelectionActive && !hasSelectedLines && (
                <ToolbarButton
                    onPress={onClearSelection}
                    testID="file-details-clear-selection"
                    label={t('common.cancel')}
                    size="md"
                    style={selectionActionStyle}
                />
            )}

            {scmWriteEnabled && canUseSelectionActions && canRemoveFromSelection && !hasSelectedLines && (
                <IconAction
                    disabled={actionBusy}
                    onPress={onUnstageFile}
                    testID="file-details-unstage-file"
                    accessibilityLabel={unstageLabel}
                    style={{ ...selectionActionStyle, minWidth: selectionActionStyle.minHeight, flexShrink: 0 }}
                >
                    <Icon name="minus" size={commandIconSize} color={theme.colors.text.secondary} />
                </IconAction>
            )}

            {scmWriteEnabled && canUseSelectionActions && diffMode === 'both' && !hasSelectedLines && (
                <Text
                    style={{
                        fontSize: 12,
                        color: theme.colors.text.secondary,
                        ...Typography.default(),
                    }}
                >
                    {t('files.fileActions.selectionHint')}
                </Text>
            )}

            {hasSelectedLines && (
                <>
                    <Pressable
                        disabled={actionBusy}
                        onPress={onApplySelectedLines}
                        testID="file-details-apply-selected-lines"
                        style={{
                            paddingHorizontal: 12,
                            paddingVertical: 6,
                            minHeight: 32,
                            borderRadius: 10,
                            backgroundColor: theme.colors.surface.base,
                            borderWidth: 1,
                            borderColor: selectedLineActionColor,
                            opacity: actionBusy ? 0.6 : 1,
                            flexShrink: useCompactSelectedLineActions ? 0 : undefined,
                        }}
                    >
                        <Text
                            numberOfLines={1}
                            style={{ color: selectedLineActionColor, fontSize: 13, ...Typography.default('semiBold') }}
                        >
                            {selectedLineActionLabel}
                        </Text>
                    </Pressable>
                    <IconAction
                        onPress={onClearSelection}
                        testID="file-details-clear-selection"
                        style={{ flexShrink: 0 }}
                        accessibilityLabel={t('files.fileActions.clearSelection')}
                    >
                        <Icon name="x" size={commandIconSize} color={theme.colors.text.secondary} />
                    </IconAction>
                </>
            )}
            {rightElement ? (
                <View testID="file-details-right" style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                    {rightElement}
                </View>
            ) : null}
        </View>
    );

    return (
        <View
            testID="file-action-toolbar"
            onLayout={onToolbarLayout}
            style={{
                flexDirection: 'row',
                flexWrap: 'nowrap',
                alignItems: 'center',
                paddingHorizontal: toolbarHorizontalPadding,
                paddingVertical: 12,
                borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                borderBottomColor: theme.colors.border.default,
                backgroundColor: theme.colors.surface.base,
                gap: actionGap,
            }}
        >
            {pathElement}
            <HorizontalScrollableRow
                testID="file-details-action-scroll"
                contentTestID="file-details-action-scroll-content"
                fadeColor={theme.colors.surface.base}
                indicatorColor={theme.colors.text.secondary}
                containerStyle={{ flex: 1, minWidth: 0 }}
                contentStyle={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: actionGap,
                }}
            >
                {viewActionsElement}
                {changeActionsElement}
            </HorizontalScrollableRow>
        </View>
    );
}
