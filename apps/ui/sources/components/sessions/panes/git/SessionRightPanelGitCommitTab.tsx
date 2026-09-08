import * as React from 'react';
import { FlatList, Platform, Pressable, View } from 'react-native';

import { SourceControlBranchSummary } from '@/components/sessions/files/SourceControlBranchSummary';
import {
    ScmCommitComposerCard,
    type ScmCommitAdjacentPushAction,
} from '@/components/sessions/sourceControl/commitComposer/ScmCommitComposerCard';
import { ScmChangeRow, resolveScmChangeStatsColumnWidth } from '@/components/sessions/sourceControl/changes/ScmChangeRow';
import { ChangedFilesViewModeMenu } from '@/components/sessions/files/ChangedFilesViewModeMenu';
import { Text } from '@/components/ui/text/Text';
import type { ScmFileStatus, ScmStatusFiles } from '@/scm/scmStatusFiles';
import type { ScmProjectInFlightOperation } from '@/sync/runtime/orchestration/projectManager';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { ChangedFilesViewMode, SessionAttributedFile, SessionAttributionReliability } from '@/scm/scmAttribution';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';
import { createAdvancedDebounce } from '@/utils/timing/debounce';
import { filterDirectoryLikeScmFileStatuses, isDirectoryLikeScmFileStatus } from '@/scm/isDirectoryLikeScmFileStatus';
import { sessionScmStashList } from '@/sync/ops';
import { useKeyboardHeight } from '@/hooks/ui/useKeyboardHeight';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { Icon } from '@/components/ui/icons/Icon';

export type SessionRightPanelGitCommitTabProps = Readonly<{
    theme: any;
    sessionId: string;
    sessionPath: string | null;
    backendLabel: string;
    commitActionLabel: string;
    scmSnapshot: ScmWorkingSnapshot | null;
    scmWriteEnabled?: boolean;
    hasConflicts: boolean;
    scmOperationBusy: boolean;
    scmOperationStatus: string | null;
    hasGlobalOperationInFlight: boolean;
    inFlightScmOperation: ScmProjectInFlightOperation | null;
    commitAllowed: boolean;
    commitBlockedMessage: string | null;

    changedFilesViewMode: ChangedFilesViewMode;
    attributionReliability: SessionAttributionReliability;
    allRepositoryChangedFiles: ScmFileStatus[];
    selectedRepositoryChangedFiles?: ScmFileStatus[];
    turnAttributedFiles?: SessionAttributedFile[];
    turnRepositoryOnlyFiles?: ScmFileStatus[];
    sessionAttributedFiles: SessionAttributedFile[];
    repositoryOnlyFiles: ScmFileStatus[];
    suppressedInferredCount: number;
    showTurnViewToggle?: boolean;
    showSessionViewToggle?: boolean;
    showSelectedViewToggle?: boolean;
    onChangedFilesViewMode?: (mode: ChangedFilesViewMode) => void;
    repositorySelectedCount: number;
    onSelectAll: () => void;
    onSelectNone: () => void;
    disableSelectAll: boolean;
    disableSelectNone: boolean;
    onFilePress: (file: ScmFileStatus) => void;
    onFilePressPinned: (file: ScmFileStatus) => void;
    onToggleSelectionForFile: (file: ScmFileStatus) => void;
    renderFileActions: (file: ScmFileStatus) => React.ReactNode;
    renderFileTrailingActions: (file: ScmFileStatus) => React.ReactNode;

    commitDraftMessage: string;
    onCommitDraftMessageChange: (value: string) => void;
    onCommitFromMessage: (message: string) => void;
    commitMessageGeneratorEnabled: boolean;
    onGenerateCommitMessageSuggestion: () => Promise<
        | { ok: true; message: string }
        | { ok: false; error: string }
    >;
    onClearSelection?: () => void;
    commitSelectionAvailable?: boolean;
    selectionModeActive?: boolean;
    onEnterSelectionMode?: () => void;
    onExitSelectionMode?: () => void;
    commitAdjacentPushAction?: ScmCommitAdjacentPushAction;

    scmStatusFiles: ScmStatusFiles | null;
    showBranchSummary?: boolean;
    showCommitComposer?: boolean;
    onOpenReviewAllChanges?: () => void;
    onOpenStashDetails?: () => void;
}>;

export const SessionRightPanelGitCommitTab = React.memo((props: SessionRightPanelGitCommitTabProps) => {
    const showCommitComposer = props.showCommitComposer !== false;
    const keyboardBottomInset = useKeyboardHeight();
    const footerBorderColor = props.theme.colors.border?.default ?? props.theme.colors.divider;
    const footerSurfaceColor = props.theme.colors.surface?.base ?? props.theme.colors.surface;
    const footerStyle = React.useMemo(() => {
        const baseStyle = {
            borderTopWidth: Platform.select({ ios: 0.33, default: 1 }),
            borderTopColor: footerBorderColor,
            backgroundColor: footerSurfaceColor,
        };

        return keyboardBottomInset > 0
            ? [baseStyle, { marginBottom: keyboardBottomInset }]
            : baseStyle;
    }, [footerBorderColor, footerSurfaceColor, keyboardBottomInset]);

    return (
        <View style={{ flex: 1, position: 'relative' }}>
            <CommitChangesSurface
                theme={props.theme}
                sessionId={props.sessionId}
                scmStatusFiles={props.scmStatusFiles}
                scmSnapshot={props.scmSnapshot}
                scmWriteEnabled={props.scmWriteEnabled}
                scmOperationBusy={props.scmOperationBusy}
                hasGlobalOperationInFlight={props.hasGlobalOperationInFlight}
                inFlightScmOperation={props.inFlightScmOperation}
                changedFilesViewMode={props.changedFilesViewMode}
                attributionReliability={props.attributionReliability}
                allRepositoryChangedFiles={props.allRepositoryChangedFiles}
                selectedRepositoryChangedFiles={props.selectedRepositoryChangedFiles}
                turnAttributedFiles={props.turnAttributedFiles}
                turnRepositoryOnlyFiles={props.turnRepositoryOnlyFiles}
                sessionAttributedFiles={props.sessionAttributedFiles}
                repositoryOnlyFiles={props.repositoryOnlyFiles}
                suppressedInferredCount={props.suppressedInferredCount}
                showTurnViewToggle={props.showTurnViewToggle}
                showSessionViewToggle={props.showSessionViewToggle}
                showSelectedViewToggle={props.showSelectedViewToggle}
                onChangedFilesViewMode={props.onChangedFilesViewMode}
                repositorySelectedCount={props.repositorySelectedCount}
                onSelectAll={props.onSelectAll}
                onSelectNone={props.onSelectNone}
                disableSelectAll={props.disableSelectAll}
                disableSelectNone={props.disableSelectNone}
                onFilePress={props.onFilePress}
                onFilePressPinned={props.onFilePressPinned}
                onToggleSelectionForFile={props.onToggleSelectionForFile}
                renderFileActions={props.renderFileActions}
                renderFileTrailingActions={props.renderFileTrailingActions}
                showBranchSummary={props.showBranchSummary}
                onOpenReviewAllChanges={props.onOpenReviewAllChanges}
                onOpenStashDetails={props.onOpenStashDetails}
            />
            {showCommitComposer ? (
                <View style={footerStyle}>
                    <CommitComposerFooter
                        theme={props.theme}
                        commitActionLabel={props.commitActionLabel}
                        externalDraftMessage={props.commitDraftMessage}
                        onExternalDraftMessageChange={props.onCommitDraftMessageChange}
                        busy={props.scmOperationBusy || props.hasGlobalOperationInFlight}
                        status={props.scmOperationStatus}
                        commitAllowed={props.commitAllowed}
                        commitBlockedMessage={props.commitBlockedMessage}
                        onCommitFromMessage={props.onCommitFromMessage}
                        commitMessageGeneratorEnabled={props.commitMessageGeneratorEnabled}
                        onGenerateCommitMessageSuggestion={props.onGenerateCommitMessageSuggestion}
                        selectionCount={props.repositorySelectedCount}
                        onClearSelection={props.onClearSelection}
                        onSelectAllSelection={props.onSelectAll}
                        commitSelectionAvailable={props.commitSelectionAvailable}
                        selectionModeActive={props.selectionModeActive}
                        onEnterSelectionMode={props.onEnterSelectionMode}
                        onExitSelectionMode={props.onExitSelectionMode}
                        pushAction={props.commitAdjacentPushAction}
                    />
                </View>
            ) : null}
        </View>
    );
});

const CommitComposerFooter = React.memo((props: Readonly<{
    theme: any;
    commitActionLabel: string;
    externalDraftMessage: string;
    onExternalDraftMessageChange: (value: string) => void;
    busy: boolean;
    status: string | null;
    commitAllowed: boolean;
    commitBlockedMessage: string | null;
    onCommitFromMessage: (message: string) => void;
    commitMessageGeneratorEnabled: boolean;
    onGenerateCommitMessageSuggestion: () => Promise<
        | { ok: true; message: string }
        | { ok: false; error: string }
    >;
    selectionCount: number;
    onClearSelection?: () => void;
    onSelectAllSelection?: () => void;
    commitSelectionAvailable?: boolean;
    selectionModeActive?: boolean;
    onEnterSelectionMode?: () => void;
    onExitSelectionMode?: () => void;
    pushAction?: ScmCommitAdjacentPushAction;
}>) => {
    const [localDraftMessage, setLocalDraftMessage] = React.useState(() => String(props.externalDraftMessage ?? ''));
    const dirtyRef = React.useRef(false);

    const debouncedPersist = React.useMemo(() => {
        return createAdvancedDebounce((value: string) => {
            props.onExternalDraftMessageChange(value);
        }, { delay: 350, immediateCount: 0 });
    }, [props.onExternalDraftMessageChange]);

    React.useEffect(() => {
        return () => {
            debouncedPersist.flush();
        };
    }, [debouncedPersist]);

    React.useEffect(() => {
        if (dirtyRef.current) return;
        setLocalDraftMessage(String(props.externalDraftMessage ?? ''));
    }, [props.externalDraftMessage]);

    const onDraftMessageChange = React.useCallback((value: string) => {
        dirtyRef.current = true;
        setLocalDraftMessage(value);
        debouncedPersist.debounced(value);
    }, [debouncedPersist]);

    const onCommitFromMessage = React.useCallback((message: string) => {
        // Persist any pending draft immediately before committing.
        debouncedPersist.flush();
        dirtyRef.current = false;
        props.onCommitFromMessage(message);
    }, [debouncedPersist, props]);

    return (
        <ScmCommitComposerCard
            theme={props.theme}
            commitActionLabel={props.commitActionLabel}
            draftMessage={localDraftMessage}
            onDraftMessageChange={onDraftMessageChange}
            busy={props.busy}
            status={props.status}
            commitAllowed={props.commitAllowed}
            commitBlockedMessage={props.commitBlockedMessage}
            onCommitFromMessage={onCommitFromMessage}
            commitMessageGeneratorEnabled={props.commitMessageGeneratorEnabled}
            onGenerateCommitMessageSuggestion={props.onGenerateCommitMessageSuggestion}
            selectionCount={props.selectionCount}
            onClearSelection={props.onClearSelection}
            onSelectAllSelection={props.onSelectAllSelection}
            commitSelectionAvailable={props.commitSelectionAvailable}
            selectionModeActive={props.selectionModeActive}
            onEnterSelectionMode={props.onEnterSelectionMode}
            onExitSelectionMode={props.onExitSelectionMode}
            variant="railFooter"
            pushAction={props.pushAction}
        />
    );
});

type CommitChangesSurfaceProps = Readonly<{
    theme: any;
    sessionId: string;
    scmStatusFiles: ScmStatusFiles | null;
    scmSnapshot: ScmWorkingSnapshot | null;
    scmWriteEnabled?: boolean;
    scmOperationBusy: boolean;
    hasGlobalOperationInFlight: boolean;
    inFlightScmOperation: ScmProjectInFlightOperation | null;
    changedFilesViewMode: ChangedFilesViewMode;
    attributionReliability: SessionAttributionReliability;
    allRepositoryChangedFiles: ScmFileStatus[];
    selectedRepositoryChangedFiles?: ScmFileStatus[];
    turnAttributedFiles?: SessionAttributedFile[];
    turnRepositoryOnlyFiles?: ScmFileStatus[];
    sessionAttributedFiles: SessionAttributedFile[];
    repositoryOnlyFiles: ScmFileStatus[];
    suppressedInferredCount: number;
    showTurnViewToggle?: boolean;
    showSessionViewToggle?: boolean;
    showSelectedViewToggle?: boolean;
    onChangedFilesViewMode?: (mode: ChangedFilesViewMode) => void;
    repositorySelectedCount: number;
    onSelectAll: () => void;
    onSelectNone: () => void;
    disableSelectAll: boolean;
    disableSelectNone: boolean;
    onFilePress: (file: ScmFileStatus) => void;
    onFilePressPinned: (file: ScmFileStatus) => void;
    onToggleSelectionForFile: (file: ScmFileStatus) => void;
    renderFileActions: (file: ScmFileStatus) => React.ReactNode;
    renderFileTrailingActions: (file: ScmFileStatus) => React.ReactNode;
    showBranchSummary?: boolean;
    onOpenReviewAllChanges?: () => void;
    onOpenStashDetails?: () => void;
}>;

function resolveSnapshotManagedStashCount(snapshot: ScmWorkingSnapshot | null): number {
    const value = snapshot?.stashCount;
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function resolveChangedFilesScopeTitle(params: Readonly<{
    changedFilesViewMode: ChangedFilesViewMode;
    repositoryCount: number;
    selectedCount: number;
    turnCount: number;
    sessionCount: number;
}>): string {
    if (params.changedFilesViewMode === 'selected') {
        return t('files.selectedForCommitChanges', { count: params.selectedCount });
    }
    if (params.changedFilesViewMode === 'turn') {
        return t('files.latestTurnChanges', { count: params.turnCount });
    }
    if (params.changedFilesViewMode === 'session') {
        return t('files.sessionAttributedChanges', { count: params.sessionCount });
    }
    return `${t('files.toolbar.changedFiles')} ${params.repositoryCount}`;
}

function resolveChangedFilesScopeDescriptions(params: Readonly<{
    changedFilesViewMode: ChangedFilesViewMode;
    attributionReliability: SessionAttributionReliability;
    suppressedInferredCount: number;
}>): string[] {
    if (params.changedFilesViewMode === 'turn') {
        return [t('files.latestTurnDescription')];
    }
    if (params.changedFilesViewMode !== 'session') {
        return [];
    }

    const descriptions = [
        params.attributionReliability === 'high'
            ? t('files.attributionReliabilityHigh')
            : t('files.attributionReliabilityLimited'),
        params.attributionReliability === 'high'
            ? t('files.attributionLegendFull')
            : t('files.attributionLegendDirectOnly'),
    ];

    if (params.suppressedInferredCount > 0) {
        descriptions.push(t('files.inferredSuppressed', { count: params.suppressedInferredCount }));
    }

    return descriptions;
}

const commitChangedFilesListContentContainerStyle = {
    paddingBottom: 12,
};

const COMMIT_CHANGED_FILES_INITIAL_RENDER_COUNT = 12;
const COMMIT_CHANGED_FILES_RENDER_BATCH_SIZE = 12;
const COMMIT_CHANGED_FILES_WINDOW_SIZE = 5;

const repositoryChangedFileKeyExtractor = (file: ScmFileStatus) => `repo-all-${file.fullPath}`;
const selectedChangedFileKeyExtractor = (file: ScmFileStatus) => `selected-${file.fullPath}`;


const CommitChangesSurface = React.memo((props: CommitChangesSurfaceProps) => {
    const themeBorderDefault = props.theme.colors.border?.default ?? props.theme.colors.divider;
    const themeSurfaceBase = props.theme.colors.surface?.base ?? props.theme.colors.surface;
    const themeSurfaceInset = props.theme.colors.surface?.inset ?? props.theme.colors.surfaceHigh ?? themeSurfaceBase;
    const themeTextPrimary = props.theme.colors.text?.primary ?? props.theme.colors.text;
    const themeTextSecondary = props.theme.colors.text?.secondary ?? props.theme.colors.textSecondary;
    const selectedMode = props.changedFilesViewMode === 'selected';
    const repositoryChangedFiles = React.useMemo(() => {
        return filterDirectoryLikeScmFileStatuses(props.allRepositoryChangedFiles);
    }, [props.allRepositoryChangedFiles]);
    const selectedChangedFiles = React.useMemo(() => {
        return filterDirectoryLikeScmFileStatuses(props.selectedRepositoryChangedFiles ?? []);
    }, [props.selectedRepositoryChangedFiles]);
    const turnChangedFiles = React.useMemo(() => {
        return (props.turnAttributedFiles ?? [])
            .filter((entry) => entry?.file && !isDirectoryLikeScmFileStatus(entry.file))
            .map((entry) => entry.file);
    }, [props.turnAttributedFiles]);
    const sessionChangedFiles = React.useMemo(() => {
        return props.sessionAttributedFiles
            .filter((entry) => entry?.file && !isDirectoryLikeScmFileStatus(entry.file))
            .map((entry) => entry.file);
    }, [props.sessionAttributedFiles]);
    const virtualizedChangedFiles = React.useMemo(() => {
        if (selectedMode) return selectedChangedFiles;
        if (props.changedFilesViewMode === 'turn') return turnChangedFiles;
        if (props.changedFilesViewMode === 'session') return sessionChangedFiles;
        return repositoryChangedFiles;
    }, [
        props.changedFilesViewMode,
        repositoryChangedFiles,
        selectedChangedFiles,
        selectedMode,
        sessionChangedFiles,
        turnChangedFiles,
    ]);
    const virtualizedStatsColumnWidth = React.useMemo(
        () => resolveScmChangeStatsColumnWidth(virtualizedChangedFiles),
        [virtualizedChangedFiles],
    );
    const showSelectedViewToggle = props.showSelectedViewToggle === true || selectedChangedFiles.length > 0;
    const hasChangedFilesViewSelector = props.showTurnViewToggle === true
        || props.showSessionViewToggle === true
        || showSelectedViewToggle;
    const turnChangedFilesCount = turnChangedFiles.length;
    const sessionChangedFilesCount = sessionChangedFiles.length;
    const scopedChangedFilesTitle = React.useMemo(() => {
        return resolveChangedFilesScopeTitle({
            changedFilesViewMode: props.changedFilesViewMode,
            repositoryCount: repositoryChangedFiles.length,
            selectedCount: selectedChangedFiles.length,
            turnCount: turnChangedFilesCount,
            sessionCount: sessionChangedFilesCount,
        });
    }, [
        props.changedFilesViewMode,
        repositoryChangedFiles.length,
        selectedChangedFiles.length,
        sessionChangedFilesCount,
        turnChangedFilesCount,
    ]);
    const scopedChangedFilesDescriptions = React.useMemo(() => {
        return resolveChangedFilesScopeDescriptions({
            changedFilesViewMode: props.changedFilesViewMode,
            attributionReliability: props.attributionReliability,
            suppressedInferredCount: props.suppressedInferredCount,
        });
    }, [
        props.attributionReliability,
        props.changedFilesViewMode,
        props.suppressedInferredCount,
    ]);
    const virtualizedKeyExtractor = React.useMemo(() => {
        if (selectedMode) return selectedChangedFileKeyExtractor;
        if (props.changedFilesViewMode === 'turn') {
            return (file: ScmFileStatus) => `turn-${file.fullPath}`;
        }
        if (props.changedFilesViewMode === 'session') {
            return (file: ScmFileStatus) => `session-${file.fullPath}`;
        }
        return repositoryChangedFileKeyExtractor;
    }, [props.changedFilesViewMode, selectedMode]);

    const scrollFades = useScrollEdgeFades({
        enabledEdges: { top: true, bottom: true },
        overflowThreshold: 1,
        edgeThreshold: 1,
    });

    const canReadManagedStashes = props.scmSnapshot?.capabilities?.readStash === true;
    const snapshotManagedStashCount = React.useMemo(
        () => resolveSnapshotManagedStashCount(props.scmSnapshot),
        [props.scmSnapshot],
    );
    const [managedStashCount, setManagedStashCount] = React.useState(snapshotManagedStashCount);

    React.useEffect(() => {
        if (!canReadManagedStashes) {
            setManagedStashCount(0);
            return;
        }
        setManagedStashCount(snapshotManagedStashCount);
    }, [canReadManagedStashes, snapshotManagedStashCount]);

    React.useEffect(() => {
        let active = true;
        if (!canReadManagedStashes) {
            setManagedStashCount(0);
            return () => {
                active = false;
            };
        }

        void (async () => {
            try {
                const response = await sessionScmStashList(props.sessionId, {});
                if (!active) return;
                if (!response.success) {
                    setManagedStashCount(snapshotManagedStashCount);
                    return;
                }
                const count =
                    typeof response.managedCount === 'number'
                        ? response.managedCount
                        : Array.isArray(response.managedStashes)
                            ? response.managedStashes.length
                            : 0;
                setManagedStashCount(count);
            } catch {
                if (!active) return;
                setManagedStashCount(snapshotManagedStashCount);
            }
        })();

        return () => {
            active = false;
        };
    }, [canReadManagedStashes, props.sessionId, props.scmSnapshot?.fetchedAt, snapshotManagedStashCount]);

    const headerContent = React.useMemo(() => {
        const lockedByOtherSession = Boolean(
            props.inFlightScmOperation && props.inFlightScmOperation.sessionId !== props.sessionId,
        );
        const branchActionsDisabled = props.scmOperationBusy || props.hasGlobalOperationInFlight || lockedByOtherSession;

        return (
            <>
                {managedStashCount > 0 && props.onOpenStashDetails ? (
                    <Pressable
                        testID="scm-stash-summary-row"
                        accessibilityRole="button"
                        accessibilityLabel={t('files.stash.summaryA11y')}
                        onPress={props.onOpenStashDetails}
                        style={({ pressed }) => ({
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 10,
                            paddingHorizontal: 12,
                            paddingVertical: 10,
                            borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                            borderBottomColor: themeBorderDefault,
                            backgroundColor: themeSurfaceBase,
                            opacity: pressed ? 0.85 : 1,
                        })}
                    >
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
                            <Icon name="archive" size={14} color={themeTextSecondary} />
                            <Text
                                numberOfLines={1}
                                style={{ fontSize: 12, color: themeTextPrimary, ...Typography.default('semiBold') }}
                            >
                                {t('files.stash.summaryTitle')}
                            </Text>
                        </View>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                            <Text style={{ fontSize: 12, color: themeTextSecondary, ...Typography.mono('semiBold') }}>
                                {String(managedStashCount)}
                            </Text>
                            <Icon name="caret-right" size={14} color={themeTextSecondary} />
                        </View>
                    </Pressable>
                ) : null}
                {props.showBranchSummary !== false && props.scmStatusFiles ? (
                    <SourceControlBranchSummary
                        theme={props.theme}
                        scmStatusFiles={props.scmStatusFiles}
                        variant="rail"
                        sessionId={props.sessionId}
                        scmSnapshot={props.scmSnapshot}
                        scmWriteEnabled={props.scmWriteEnabled}
                        disabled={branchActionsDisabled}
                    />
                ) : null}
                <View
                    style={{
                        paddingHorizontal: 12,
                        paddingTop: 10,
                        paddingBottom: 8,
                        borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                        borderBottomColor: themeBorderDefault,
                        backgroundColor: themeSurfaceInset,
                    }}
                >
                    <View
                        testID="session-rightpanel-git-scope-actions-row"
                        style={{
                            flexDirection: 'row',
                            alignItems: hasChangedFilesViewSelector ? 'flex-start' : 'center',
                            justifyContent: 'space-between',
                            gap: 10,
                        }}
                    >
                        <View style={{ flex: 1, minWidth: 0, justifyContent: hasChangedFilesViewSelector ? 'flex-start' : 'center' }}>
                            {hasChangedFilesViewSelector ? (
                                <ChangedFilesViewModeMenu
                                    theme={props.theme}
                                    changedFilesViewMode={props.changedFilesViewMode}
                                    showSelectedViewToggle={showSelectedViewToggle}
                                    showTurnViewToggle={props.showTurnViewToggle}
                                    showSessionViewToggle={props.showSessionViewToggle}
                                    onChangedFilesViewMode={props.onChangedFilesViewMode}
                                    testID="session-rightpanel-git-view-mode-menu"
                                    triggerLabel={scopedChangedFilesTitle}
                                    triggerLabelColor={themeTextPrimary}
                                    triggerStyle={{ alignSelf: 'flex-start', maxWidth: '100%' }}
                                    popoverAnchorAlign="start"
                                />
                            ) : (
                                <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
                                    <Text style={{ fontSize: 12, color: themeTextPrimary, ...Typography.default('semiBold') }}>
                                        {t('files.toolbar.changedFiles')}
                                    </Text>
                                    <Text style={{ fontSize: 11, color: themeTextSecondary, ...Typography.mono('semiBold') }}>
                                        {String(repositoryChangedFiles.length)}
                                    </Text>
                                </View>
                            )}
                        </View>
                        <View style={{ flexDirection: 'row', alignItems: hasChangedFilesViewSelector ? 'flex-start' : 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                            {hasChangedFilesViewSelector ? null : (
                                <ChangedFilesViewModeMenu
                                    theme={props.theme}
                                    changedFilesViewMode={props.changedFilesViewMode}
                                    showSelectedViewToggle={showSelectedViewToggle}
                                    showTurnViewToggle={props.showTurnViewToggle}
                                    showSessionViewToggle={props.showSessionViewToggle}
                                    onChangedFilesViewMode={props.onChangedFilesViewMode}
                                    testID="session-rightpanel-git-view-mode-menu"
                                />
                            )}
                            {props.onOpenReviewAllChanges ? (
                                <ToolbarButton
                                    testID="session-rightpanel-git-open-review"
                                    label={t('files.toolbar.review')}
                                    icon={<Icon name="git-diff" size={14} color={themeTextSecondary} />}
                                    onPress={props.onOpenReviewAllChanges}
                                />
                            ) : null}
                        </View>
                    </View>
                    {hasChangedFilesViewSelector && scopedChangedFilesDescriptions.length > 0 ? (
                        <View testID="session-rightpanel-git-scope-description" style={{ marginTop: 6 }}>
                            {scopedChangedFilesDescriptions.map((description, index) => (
                                <Text
                                    key={`${index}:${description}`}
                                    numberOfLines={2}
                                    style={{
                                        marginTop: index === 0 ? 0 : 2,
                                        fontSize: index === 0 ? 12 : 11,
                                        color: themeTextSecondary,
                                        ...Typography.default(),
                                    }}
                                >
                                    {description}
                                </Text>
                            ))}
                        </View>
                    ) : null}
                </View>
            </>
        );
    }, [
        repositoryChangedFiles.length,
        hasChangedFilesViewSelector,
        managedStashCount,
        props.onOpenStashDetails,
        props.onOpenReviewAllChanges,
        props.changedFilesViewMode,
        props.onChangedFilesViewMode,
        props.scmStatusFiles,
        props.scmSnapshot,
        props.scmWriteEnabled,
        props.hasGlobalOperationInFlight,
        props.inFlightScmOperation,
        props.scmOperationBusy,
        props.sessionId,
        props.showSessionViewToggle,
        showSelectedViewToggle,
        props.showTurnViewToggle,
        themeBorderDefault,
        themeSurfaceBase,
        themeSurfaceInset,
        themeTextPrimary,
        themeTextSecondary,
        scopedChangedFilesDescriptions,
        scopedChangedFilesTitle,
    ]);

    const virtualizedRowStateRef = React.useRef({
        onFilePress: props.onFilePress,
        onFilePressPinned: props.onFilePressPinned,
        onToggleSelectionForFile: props.onToggleSelectionForFile,
        renderFileActions: props.renderFileActions,
        renderFileTrailingActions: props.renderFileTrailingActions,
        theme: props.theme,
        virtualizedChangedFilesLength: virtualizedChangedFiles.length,
        virtualizedStatsColumnWidth,
    });
    virtualizedRowStateRef.current = {
        onFilePress: props.onFilePress,
        onFilePressPinned: props.onFilePressPinned,
        onToggleSelectionForFile: props.onToggleSelectionForFile,
        renderFileActions: props.renderFileActions,
        renderFileTrailingActions: props.renderFileTrailingActions,
        theme: props.theme,
        virtualizedChangedFilesLength: virtualizedChangedFiles.length,
        virtualizedStatsColumnWidth,
    };
    // `renderItem` (below) reads everything from `virtualizedRowStateRef` so its
    // identity stays stable for FlatList perf. RN's FlatList only re-renders
    // cells when `data` or `extraData` change — NOT when `renderItem` (or a ref
    // it reads) changes. So `extraData` MUST carry every dynamic value that
    // affects a row's rendered output, including the per-row render callbacks.
    // Omitting `renderFileActions` is what made the commit-selection "+" appear
    // only after an unrelated data change flushed the cached cells. (The shared
    // `DiffFilesListView` already follows this discipline by putting
    // `renderFileRow` in its own `listExtraData`.) `renderFileActions` /
    // `renderFileTrailingActions` change identity on selection-mode entry/exit
    // AND on every per-file selection toggle, so including them keeps the "+"
    // and its checked state in sync immediately.
    const virtualizedRowExtraData = React.useMemo(() => ({
        statsColumnWidth: virtualizedStatsColumnWidth,
        textPrimary: themeTextPrimary,
        textSecondary: themeTextSecondary,
        virtualizedChangedFilesLength: virtualizedChangedFiles.length,
        renderFileActions: props.renderFileActions,
        renderFileTrailingActions: props.renderFileTrailingActions,
    }), [
        themeTextPrimary,
        themeTextSecondary,
        virtualizedChangedFiles.length,
        virtualizedStatsColumnWidth,
        props.renderFileActions,
        props.renderFileTrailingActions,
    ]);

    const renderVirtualizedRow = React.useCallback(({ item: file, index }: { item: ScmFileStatus; index: number }) => {
        const {
            onFilePress,
            onFilePressPinned,
            onToggleSelectionForFile,
            renderFileActions,
            renderFileTrailingActions,
            theme,
            virtualizedChangedFilesLength,
            virtualizedStatsColumnWidth,
        } = virtualizedRowStateRef.current;
        return (
            <ScmChangeRow
                theme={theme}
                file={file}
                density="compact"
                leadingElement={renderFileActions ? renderFileActions(file) : null}
                trailingElement={renderFileTrailingActions ? renderFileTrailingActions(file) : null}
                onPress={() => onFilePress(file)}
                onPressPinned={() => onFilePressPinned(file)}
                onToggleSelection={onToggleSelectionForFile ? () => onToggleSelectionForFile(file) : undefined}
                statsColumnWidth={virtualizedStatsColumnWidth}
                showDivider={index < virtualizedChangedFilesLength - 1}
            />
        );
    }, []);

    const emptyChangedFilesContent = React.useMemo(() => {
        const label = props.changedFilesViewMode === 'turn'
            ? t('files.noLatestTurnChanges')
            : props.changedFilesViewMode === 'session'
                ? t('files.noSessionAttributedChanges')
                : t('files.noChanges');
        return (
            <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                <Text style={{ color: themeTextSecondary, fontSize: 12, ...Typography.default() }}>
                    {label}
                </Text>
            </View>
        );
    }, [props.changedFilesViewMode, themeTextSecondary]);

    return (
        <View style={{ flex: 1, position: 'relative' }}>
            <FlatList
                data={virtualizedChangedFiles}
                keyExtractor={virtualizedKeyExtractor}
                ListHeaderComponent={headerContent}
                ListEmptyComponent={emptyChangedFilesContent}
                contentContainerStyle={commitChangedFilesListContentContainerStyle}
                renderItem={renderVirtualizedRow}
                extraData={virtualizedRowExtraData}
                initialNumToRender={Math.min(COMMIT_CHANGED_FILES_INITIAL_RENDER_COUNT, virtualizedChangedFiles.length)}
                maxToRenderPerBatch={COMMIT_CHANGED_FILES_RENDER_BATCH_SIZE}
                windowSize={COMMIT_CHANGED_FILES_WINDOW_SIZE}
                removeClippedSubviews={Platform.OS !== 'web'}
                onLayout={scrollFades.onViewportLayout}
                onContentSizeChange={scrollFades.onContentSizeChange}
                onScroll={scrollFades.onScroll}
                scrollEventThrottle={16}
            />

            <ScrollEdgeFades
                color={themeSurfaceBase}
                size={18}
                edges={scrollFades.visibility}
            />
            <ScrollEdgeIndicators
                edges={scrollFades.visibility}
                color={themeTextSecondary}
                size={14}
                opacity={0.35}
            />
        </View>
    );
});
