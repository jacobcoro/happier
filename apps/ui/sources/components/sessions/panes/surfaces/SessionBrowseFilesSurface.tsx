import * as React from 'react';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { resolveSessionPaneScopeId } from '../sessionPaneScopeId';

import { SessionRepositoryTreeBrowserView } from '@/components/sessions/files/views/SessionRepositoryTreeBrowserView';

export const SessionBrowseFilesSurface = React.memo((props: Readonly<{
    sessionId: string;
    scopeId?: string;
    onOpenFile: (fullPath: string) => void;
    onOpenFilePinned: (fullPath: string) => void;
}>) => {
    const pane = useAppPaneScope(props.scopeId ?? resolveSessionPaneScopeId(props.sessionId));
    const files = pane.scopeState?.right.tabState.files as { revealRequest?: Readonly<{ path: string }> } | undefined;
    return (
    <SessionRepositoryTreeBrowserView
        sessionId={props.sessionId}
        onOpenFile={props.onOpenFile}
        onOpenFilePinned={props.onOpenFilePinned}
        revealRequest={files?.revealRequest}
        density="panel"
    />
);
});
