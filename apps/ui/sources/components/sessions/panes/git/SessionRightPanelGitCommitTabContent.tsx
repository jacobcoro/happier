import * as React from 'react';
import { SessionRightPanelGitCommitTab } from '@/components/sessions/panes/git/SessionRightPanelGitCommitTab';
import { ScmCommitSelectionToggleButton } from '@/components/sessions/sourceControl/commitSelection/ScmCommitSelectionToggleButton';
import { ScmChangeOverflowMenu } from '@/components/sessions/sourceControl/changes/ScmChangeOverflowMenu';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import { applyFileDiscardAction } from '@/scm/operations/applyFileDiscardAction';
import { fireAndForget } from '@/utils/system/fireAndForget';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import {
    getDefaultChangedFilesViewMode,
    resolveChangedFilesViewMode,
    type ChangedFilesViewMode,
} from '@/scm/scmAttribution';
import { filterDirectoryLikeScmFileStatuses, isDirectoryLikeScmFileStatus } from '@/scm/isDirectoryLikeScmFileStatus';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { ScmCommitSelectionPatch } from '@/sync/domains/state/storageTypes';
import type { ScmProjectInFlightOperation, ScmProjectOperationLogEntry } from '@/sync/runtime/orchestration/projectManager';
import { useChangedFilesData } from '@/hooks/session/files/useChangedFilesData';
import { useDerivedSessionChangeSet } from '@/sync/domains/session/changes/hooks/useDerivedSessionChangeSet';
import { useSessionRightPanelGitCommitSelection } from './useSessionRightPanelGitCommitSelection';
import type { ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import type { ScmCommitAdjacentPushAction } from '@/components/sessions/sourceControl/commitComposer/ScmCommitComposerCard';

export type SessionRightPanelGitCommitTabContentProps = Readonly<{
    theme: any;
    sessionId: string;
    sessionPath: string | null;
    scmSnapshot: ScmWorkingSnapshot;
    touchedPaths: string[];
    operationLog: readonly ScmProjectOperationLogEntry[];
    projectSessionIds: string[];
    commitSelectionPaths: readonly string[];
    commitSelectionPatches: readonly ScmCommitSelectionPatch[];
    scmCommitStrategy: ScmCommitStrategy;
    scmWriteEnabled: boolean;
    inFlightScmOperation: ScmProjectInFlightOperation | null;
    hasGlobalOperationInFlight: boolean;
    scmOperationBusy: boolean;
    scmOperationStatus: string | null;
    backendLabel: string;
    commitActionLabel: string;
    hasConflicts: boolean;
    commitAllowedForComposer: boolean;
    commitBlockedMessageForComposer: string | null;
    commitWriteEnabled: boolean;
    commitSelectionUiEnabled: boolean;
    commitDraftMessage: string;
    onCommitDraftMessageChange: (value: string) => void;
    onCommitFromMessage: (message: string) => void;
    commitMessageGeneratorEnabled: boolean;
    onGenerateCommitMessageSuggestion: () => Promise<
        | { ok: true; message: string }
        | { ok: false; error: string }
    >;
    commitAdjacentPushAction?: ScmCommitAdjacentPushAction;
    showBranchSummary?: boolean;
    onOpenFilesSidebar: (revealPath?: string) => void;
    onOpenReviewAllChanges: () => void;
    onOpenStashDetails: () => void;
    openFileInDetails: (fullPath: string) => void;
    openFileInDetailsPinned: (fullPath: string) => void;
}>;

export const SessionRightPanelGitCommitTabContent = React.memo((props: SessionRightPanelGitCommitTabContentProps) => {
    const copyFeedback = useTemporaryCopyFeedback();
    const commitSelectionUiEnabled = props.commitSelectionUiEnabled === true;
    const { latestTurnScopedChangeSet, sessionChangeSet } = useDerivedSessionChangeSet(props.sessionId);

    const [requestedChangedFilesViewMode, setChangedFilesViewMode] = React.useState<ChangedFilesViewMode>(() => {
        if (latestTurnScopedChangeSet) return 'turn' as const;
        if (sessionChangeSet) return 'session' as const;
        return getDefaultChangedFilesViewMode();
    });

    const changed = useChangedFilesData({
        sessionId: props.sessionId,
        scmSnapshot: props.scmSnapshot,
        touchedPaths: props.touchedPaths,
        operationLog: props.operationLog,
        projectSessionIds: props.projectSessionIds,
        searchQuery: '',
        showAllRepositoryFiles: false,
        latestTurnChangeSet: latestTurnScopedChangeSet,
        sessionChangeSet,
    });

    const allRepositoryChangedFiles = React.useMemo(() => {
        return filterDirectoryLikeScmFileStatuses(changed.allRepositoryChangedFiles);
    }, [changed.allRepositoryChangedFiles]);

    const turnAttributedFiles = React.useMemo(() => {
        return changed.turnAttributedFiles.filter((entry) => entry?.file && !isDirectoryLikeScmFileStatus(entry.file));
    }, [changed.turnAttributedFiles]);

    const turnRepositoryOnlyFiles = React.useMemo(() => {
        return filterDirectoryLikeScmFileStatuses(changed.turnRepositoryOnlyFiles);
    }, [changed.turnRepositoryOnlyFiles]);

    const sessionAttributedFiles = React.useMemo(() => {
        return changed.sessionAttributedFiles.filter((entry) => entry?.file && !isDirectoryLikeScmFileStatus(entry.file));
    }, [changed.sessionAttributedFiles]);

    const repositoryOnlyFiles = React.useMemo(() => {
        return filterDirectoryLikeScmFileStatuses(changed.repositoryOnlyFiles);
    }, [changed.repositoryOnlyFiles]);

    const {
        repositorySelectedCount,
        isSelectedForCommit,
        toggleCommitSelectionForFile,
        bulkSelectAll,
        bulkSelectFiles,
        bulkSelectNone,
        disableSelectAll,
        disableSelectNone,
    } = useSessionRightPanelGitCommitSelection({
        sessionId: props.sessionId,
        sessionPath: props.sessionPath,
        scmSnapshot: props.scmSnapshot,
        scmWriteEnabled: props.scmWriteEnabled,
        scmCommitStrategy: props.scmCommitStrategy,
        commitSelectionPaths: props.commitSelectionPaths,
        commitSelectionPatches: props.commitSelectionPatches,
        changedFiles: allRepositoryChangedFiles,
    });

    const [selectionModeUserOn, setSelectionModeUserOn] = React.useState(false);
    // Selection mode is an explicit opt-in: rows stay free of the per-file "+" until the
    // user taps "Select files to commit". A non-empty selection always forces it on so a
    // pending selection can never be silently hidden.
    const selectionModeActive = commitSelectionUiEnabled && (selectionModeUserOn || repositorySelectedCount > 0);
    const enterSelectionMode = React.useCallback(() => setSelectionModeUserOn(true), []);
    const exitSelectionMode = React.useCallback(() => setSelectionModeUserOn(false), []);

    const selectedRepositoryChangedFiles = React.useMemo(() => {
        return allRepositoryChangedFiles.filter((file) => isSelectedForCommit(file));
    }, [allRepositoryChangedFiles, isSelectedForCommit]);

    const showSelectedViewToggle = selectedRepositoryChangedFiles.length > 0;

    const changedFilesViewMode = React.useMemo(() => resolveChangedFilesViewMode({
        mode: requestedChangedFilesViewMode,
        showTurnViewToggle: changed.showTurnViewToggle,
        showSessionViewToggle: changed.showSessionViewToggle,
        showSelectedViewToggle,
    }), [changed.showSessionViewToggle, changed.showTurnViewToggle, requestedChangedFilesViewMode, showSelectedViewToggle]);

    const currentScopeChangedFiles = React.useMemo<readonly ScmFileStatus[]>(() => {
        if (changedFilesViewMode === 'selected') return selectedRepositoryChangedFiles;
        if (changedFilesViewMode === 'turn') {
            return turnAttributedFiles.map((entry) => entry.file);
        }
        if (changedFilesViewMode === 'session') {
            return sessionAttributedFiles.map((entry) => entry.file);
        }
        return allRepositoryChangedFiles;
    }, [
        allRepositoryChangedFiles,
        changedFilesViewMode,
        selectedRepositoryChangedFiles,
        sessionAttributedFiles,
        turnAttributedFiles,
    ]);

    const bulkSelectCurrentScope = React.useCallback(() => {
        if (changedFilesViewMode === 'repository') {
            bulkSelectAll();
            return;
        }
        bulkSelectFiles(currentScopeChangedFiles);
    }, [bulkSelectAll, bulkSelectFiles, changedFilesViewMode, currentScopeChangedFiles]);

    const renderCommitSelectionAction = React.useCallback((file: ScmFileStatus) => {
        const selectedForCommit = isSelectedForCommit(file);
        return (
            <ScmCommitSelectionToggleButton
                sessionId={props.sessionId}
                sessionPath={props.sessionPath}
                snapshot={props.scmSnapshot}
                scmWriteEnabled={props.scmWriteEnabled}
                commitStrategy={props.scmCommitStrategy}
                file={file}
                selectedForCommit={selectedForCommit}
                surface="files"
            />
        );
    }, [isSelectedForCommit, props.scmCommitStrategy, props.scmSnapshot, props.scmWriteEnabled, props.sessionId, props.sessionPath]);

    const noop = React.useCallback(() => {}, []);
    const noopFile = React.useCallback((_file: ScmFileStatus) => {}, []);
    const renderNull = React.useCallback((_file: ScmFileStatus) => null, []);

    const revealInTree = React.useCallback((fullPath: string) => {
        props.onOpenFilesSidebar(fullPath);
    }, [props.onOpenFilesSidebar]);

    const renderTrailingActions = React.useCallback((file: ScmFileStatus) => {
        const discardEnabled = props.scmWriteEnabled && props.scmSnapshot?.capabilities?.writeDiscard === true;
        return (
            <>
                <CopiedPill
                    visible={copyFeedback.isCopied(file.fullPath)}
                    testID={`scm-change-copy-feedback:${file.fullPath}`}
                />
                <ScmChangeOverflowMenu
                    title={file.fileName}
                    filePath={file.fullPath}
                    onCopyPathSuccess={() => copyFeedback.markCopied(file.fullPath)}
                    onRevealInTree={() => {
                        revealInTree(file.fullPath);
                    }}
                    onDiscard={discardEnabled ? () => {
                        fireAndForget(applyFileDiscardAction({
                            sessionId: props.sessionId,
                            sessionPath: props.sessionPath,
                            file,
                            snapshot: props.scmSnapshot,
                            scmWriteEnabled: props.scmWriteEnabled,
                            commitStrategy: props.scmCommitStrategy,
                            surface: 'files',
                        }), { tag: 'SessionRightPanelGitCommitTab.discard' });
                    } : undefined}
                />
            </>
        );
    }, [copyFeedback, props.scmCommitStrategy, props.scmSnapshot, props.scmWriteEnabled, props.sessionId, props.sessionPath, revealInTree]);

    const onFilePress = React.useCallback((file: ScmFileStatus) => {
        props.openFileInDetails(file.fullPath);
    }, [props.openFileInDetails]);

    const onFilePressPinned = React.useCallback((file: ScmFileStatus) => {
        props.openFileInDetailsPinned(file.fullPath);
    }, [props.openFileInDetailsPinned]);

    return (
        <SessionRightPanelGitCommitTab
            theme={props.theme}
            sessionId={props.sessionId}
            sessionPath={props.sessionPath}
            backendLabel={props.backendLabel}
            commitActionLabel={props.commitActionLabel}
            scmSnapshot={props.scmSnapshot}
            scmWriteEnabled={props.scmWriteEnabled}
            hasConflicts={props.hasConflicts}
            scmOperationBusy={props.scmOperationBusy}
            scmOperationStatus={props.scmOperationStatus}
            hasGlobalOperationInFlight={props.hasGlobalOperationInFlight}
            inFlightScmOperation={props.inFlightScmOperation}
            commitAllowed={props.commitAllowedForComposer}
            commitBlockedMessage={props.commitBlockedMessageForComposer}
            changedFilesViewMode={changedFilesViewMode}
            attributionReliability={changed.attributionReliability}
            allRepositoryChangedFiles={allRepositoryChangedFiles}
            selectedRepositoryChangedFiles={selectedRepositoryChangedFiles}
            turnAttributedFiles={turnAttributedFiles}
            turnRepositoryOnlyFiles={turnRepositoryOnlyFiles}
            sessionAttributedFiles={sessionAttributedFiles}
            repositoryOnlyFiles={repositoryOnlyFiles}
            suppressedInferredCount={changed.suppressedInferredCount}
            showTurnViewToggle={changed.showTurnViewToggle}
            showSessionViewToggle={changed.showSessionViewToggle}
            showSelectedViewToggle={showSelectedViewToggle}
            onChangedFilesViewMode={setChangedFilesViewMode}
            repositorySelectedCount={repositorySelectedCount}
            onSelectAll={commitSelectionUiEnabled ? bulkSelectCurrentScope : noop}
            onSelectNone={commitSelectionUiEnabled ? bulkSelectNone : noop}
            disableSelectAll={commitSelectionUiEnabled ? disableSelectAll || currentScopeChangedFiles.length === 0 : true}
            disableSelectNone={commitSelectionUiEnabled ? disableSelectNone : true}
            onFilePress={onFilePress}
            onFilePressPinned={onFilePressPinned}
            onToggleSelectionForFile={commitSelectionUiEnabled ? toggleCommitSelectionForFile : noopFile}
            renderFileActions={selectionModeActive ? renderCommitSelectionAction : renderNull}
            renderFileTrailingActions={renderTrailingActions}
            commitDraftMessage={props.commitDraftMessage}
            onCommitDraftMessageChange={props.onCommitDraftMessageChange}
            onCommitFromMessage={props.onCommitFromMessage}
            commitMessageGeneratorEnabled={props.commitMessageGeneratorEnabled}
            onGenerateCommitMessageSuggestion={props.onGenerateCommitMessageSuggestion}
            commitAdjacentPushAction={props.commitAdjacentPushAction}
            onClearSelection={commitSelectionUiEnabled && repositorySelectedCount > 0 ? bulkSelectNone : undefined}
            commitSelectionAvailable={commitSelectionUiEnabled}
            selectionModeActive={selectionModeActive}
            onEnterSelectionMode={enterSelectionMode}
            onExitSelectionMode={exitSelectionMode}
            scmStatusFiles={changed.scmStatusFiles}
            showBranchSummary={props.showBranchSummary}
            showCommitComposer={props.commitWriteEnabled}
            onOpenReviewAllChanges={props.onOpenReviewAllChanges}
            onOpenStashDetails={props.onOpenStashDetails}
        />
    );
});
