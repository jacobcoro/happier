import { useAuth } from '@/auth/context/AuthContext';
import * as React from 'react';
import { Stack, usePathname } from 'expo-router';
import { useIsTablet } from '@/utils/platform/responsive';
import { SidebarView } from './SidebarView';
import { CollapsedSidebarView } from './CollapsedSidebarView';
import { View, useWindowDimensions, Platform } from 'react-native';
import { useLocalSetting, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { ResizableDockedPane, type ResizableDockedPaneCommitMeta } from '@/components/ui/panels/ResizableDockedPane';
import { PANE_SIZING_DEFAULTS, resolveScaledPaneWidthPx } from '@/components/appShell/panes/layout/paneSizing';
import { StyleSheet } from 'react-native-unistyles';
import { resolveSidebarDockMaxWidthPx, SIDEBAR_COLLAPSED_WIDTH_PX, SIDEBAR_DOCK_MIN_WIDTH_PX } from './sidebarSizing';
import { useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import { resolvePaneFocusModeRouteScopeId } from '@/components/appShell/panes/focusMode/resolvePaneFocusModeRouteScopeId';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { DesktopMainContentDragSurface } from '@/components/navigation/desktopWindowChrome/DesktopMainContentDragSurface';
import { isDesktopPetOverlayWindowContext } from '@/components/pets/desktop/runtime/isDesktopPetOverlayWindowContext';

const TERMINAL_CONNECT_ROUTE = '/terminal/connect';
const EXPANDED_SIDEBAR_MIN_WINDOW_WIDTH_PX = SIDEBAR_DOCK_MIN_WIDTH_PX + PANE_SIZING_DEFAULTS.mainMinPx;

function isTerminalConnectWebPathname(pathname: string | null | undefined): boolean {
    const route = String(pathname ?? '').split('?')[0]?.replace(/\/+$/, '');
    return route === TERMINAL_CONNECT_ROUTE;
}

/**
 * Radius on the sidebar-facing side of the content sheet only. The window-facing edges stay
 * square so the sheet reads as flush to the window and never stacks its own curve on top of
 * the OS window's rounded corners.
 */
const CONTENT_SHEET_SEAM_RADIUS_PX = 16;


const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flexDirection: 'row',
        minWidth: 0,
        minHeight: 0,
        flex: 1,
        position: 'relative',
    },
    canvas: {
        // The plane the content sheet lies on. Painted here so the sheet's rounded
        // sidebar-facing corners reveal the canvas rather than whatever is behind the app.
        backgroundColor: theme.colors.background.canvas,
    },
    content: {
        flex: 1,
        minWidth: 0,
        minHeight: 0,
    },
    contentSheet: {
        borderTopLeftRadius: CONTENT_SHEET_SEAM_RADIUS_PX,
        borderBottomLeftRadius: CONTENT_SHEET_SEAM_RADIUS_PX,
        overflow: 'hidden',
        ...(Platform.OS === 'web' ? {} : {
            borderLeftWidth: StyleSheet.hairlineWidth,
            borderLeftColor: theme.colors.border.default,
        }),
    },
    /**
     * The seam shadow. An inert overlay tracing the content sheet's exact footprint — same left
     * corners, transparent fill — whose only job is to cast the sheet's lift shadow leftward onto
     * the sidebar.
     *
     * Keep it outside the clipped content sheet so the shadow can reach the sidebar.
     *
     * It has to be sheet-SHAPED rather than a strip: a straight strip casts a straight-edged band
     * that runs on past the rounded corners, so the shadow and the edge it describes disagree.
     * Matching the radii makes the cast follow the curve.
     *
     * x-offset only with no spread — the offset keeps the cast on the sidebar side, and the top,
     * right and bottom casts fall beyond the window edges where nothing can show them. Dark needs
     * roughly 3x the alpha to register over a dark canvas.
     */
    contentSheetSeamShadow: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        right: 0,
        borderTopLeftRadius: CONTENT_SHEET_SEAM_RADIUS_PX,
        borderBottomLeftRadius: CONTENT_SHEET_SEAM_RADIUS_PX,
        zIndex: 2,
        boxShadow: theme.dark
            ? '-5px 0 22px rgba(0, 0, 0, 0.13)'
            : '-5px 0 22px rgba(0, 0, 0, 0.035)',
    },
}));

export type SidebarNavigatorProps = Readonly<{
    desktopUpdateIndicator?: React.ReactNode;
}>;

export const SidebarNavigator = React.memo((props: SidebarNavigatorProps) => {
    const styles = stylesheet;
    const auth = useAuth();
    const isTablet = useIsTablet();
    const pathname = usePathname();
    const isDesktopPetOverlayWindow = isDesktopPetOverlayWindowContext();
    const bypassSidebar = Platform.OS === 'web' && isTerminalConnectWebPathname(pathname);
    const showSidebar = auth.isAuthenticated && isTablet && !isDesktopPetOverlayWindow && !bypassSidebar;
    const routeScopeId = React.useMemo(() => resolvePaneFocusModeRouteScopeId(pathname), [pathname]);
    const { state: paneState, dispatch: dispatchPaneAction } = useAppPaneContext();
    const focusedScopeId = paneState.focusMode.scopeId;
    const focusedScope = focusedScopeId ? paneState.scopes[focusedScopeId] : undefined;
    const paneFocusModeChromeActive =
        Boolean(focusedScopeId)
        && focusedScopeId === routeScopeId
        && paneState.activeScopeId === focusedScopeId
        && Boolean(focusedScope?.right.isOpen || focusedScope?.details.isOpen);
    const { width: windowWidth } = useWindowDimensions();
    const sidebarCollapsed = useLocalSetting('sidebarCollapsed');
    const [, setSidebarCollapsed] = useLocalSettingMutable('sidebarCollapsed');
    const sidebarWidthPx = useLocalSetting('sidebarWidthPx');
    const sidebarWidthBasisPx = useLocalSetting('sidebarWidthBasisPx');
    const [, setSidebarWidthPx] = useLocalSettingMutable('sidebarWidthPx');
    const [, setSidebarWidthBasisPx] = useLocalSettingMutable('sidebarWidthBasisPx');
    const [dragSidebarWidthPx, setDragSidebarWidthPx] = React.useState<number | null>(null);
    const collapseTriggeredDuringDragRef = React.useRef(false);
    const forceCompactSidebarForViewport =
        Platform.OS === 'web'
        && showSidebar
        && Number.isFinite(windowWidth)
        && windowWidth < EXPANDED_SIDEBAR_MIN_WINDOW_WIDTH_PX;
    const effectiveSidebarCollapsed = Boolean(sidebarCollapsed || paneFocusModeChromeActive || forceCompactSidebarForViewport);

    React.useEffect(() => {
        if (!focusedScopeId) return;
        if (focusedScopeId !== routeScopeId) {
            dispatchPaneAction({ type: 'exitFocusMode', scopeId: focusedScopeId });
            return;
        }
        if (!focusedScope?.right.isOpen && !focusedScope?.details.isOpen) {
            dispatchPaneAction({ type: 'exitFocusMode', scopeId: focusedScopeId });
        }
    }, [
        dispatchPaneAction,
        focusedScope?.details.isOpen,
        focusedScope?.right.isOpen,
        focusedScopeId,
        routeScopeId,
    ]);

    const stopScrollEventPropagationOnWeb = React.useCallback((event: { stopPropagation?: () => void }) => {
        // Expo Router (Vaul/Radix) modals on web often install document-level scroll-lock listeners
        // that `preventDefault()` wheel/touch scroll, which breaks scrolling inside nested scroll views
        // (including the docked sidebar). Stopping propagation here keeps scroll events
        // within the sidebar subtree so native scrolling works.
        if (Platform.OS !== 'web') return;
        if (typeof event?.stopPropagation === 'function') event.stopPropagation();
    }, []);

    const sidebarMaxWidthPx = React.useMemo(() => resolveSidebarDockMaxWidthPx(windowWidth), [windowWidth]);

    const effectiveSidebarWidthPx = React.useMemo(() => {
        return resolveScaledPaneWidthPx({
            preferredWidthPx: sidebarWidthPx,
            basisContainerWidthPx: sidebarWidthBasisPx,
            containerWidthPx: windowWidth,
            minPx: SIDEBAR_DOCK_MIN_WIDTH_PX,
            maxPx: sidebarMaxWidthPx,
        });
    }, [sidebarMaxWidthPx, sidebarWidthBasisPx, sidebarWidthPx, windowWidth]);

    // Hidden chrome occupies no space; the mounted navigation owner is unchanged.
    const sidebarWidth = React.useMemo(() => {
        if (!showSidebar) return 0;
        if (effectiveSidebarCollapsed) return SIDEBAR_COLLAPSED_WIDTH_PX;
        return dragSidebarWidthPx ?? effectiveSidebarWidthPx;
    }, [dragSidebarWidthPx, effectiveSidebarCollapsed, effectiveSidebarWidthPx, showSidebar]);

    const handleSidebarWidthDrag = React.useCallback((nextWidthPx: number | null, dragMeta?: ResizableDockedPaneCommitMeta | null) => {
        if (nextWidthPx == null) {
            collapseTriggeredDuringDragRef.current = false;
            setDragSidebarWidthPx(null);
            return;
        }

        const shouldCollapseToCompactView =
            Platform.OS === 'web'
            && !effectiveSidebarCollapsed
            && !collapseTriggeredDuringDragRef.current
            && nextWidthPx <= SIDEBAR_DOCK_MIN_WIDTH_PX
            && dragMeta?.exceededMinPx === true;

        if (shouldCollapseToCompactView) {
            collapseTriggeredDuringDragRef.current = true;
            setDragSidebarWidthPx(null);
            setSidebarCollapsed(true);
            return;
        }

        setDragSidebarWidthPx(nextWidthPx);
    }, [effectiveSidebarCollapsed, setSidebarCollapsed]);

    const handleSidebarWidthCommit = React.useCallback((nextWidthPx: number) => {
        collapseTriggeredDuringDragRef.current = false;
        setDragSidebarWidthPx(null);
        setSidebarWidthPx(nextWidthPx);
        setSidebarWidthBasisPx(windowWidth);
    }, [setSidebarWidthBasisPx, setSidebarWidthPx, windowWidth]);

    const handleCollapsedSidebarExpand = React.useCallback(() => {
        if (paneFocusModeChromeActive) {
            dispatchPaneAction({ type: 'exitFocusMode' });
        }
        setSidebarCollapsed(false);
    }, [dispatchPaneAction, paneFocusModeChromeActive, setSidebarCollapsed]);

    const handleCollapsedSidebarExitFocusMode = React.useCallback(() => {
        if (paneFocusModeChromeActive) {
            dispatchPaneAction({ type: 'exitFocusMode' });
        }
    }, [dispatchPaneAction, paneFocusModeChromeActive]);

    const stackNavigationOptions = React.useMemo(() => ({
        lazy: false,
        headerShown: false,
    }), []);

    const sidebar = !showSidebar ? null : effectiveSidebarCollapsed ? (
        <CollapsedSidebarView
            desktopUpdateIndicator={props.desktopUpdateIndicator}
            focusModeActive={paneFocusModeChromeActive}
            onExitFocusMode={handleCollapsedSidebarExitFocusMode}
            onRequestExpand={handleCollapsedSidebarExpand}
        />
    ) : (
        <ResizableDockedPane
            widthPx={sidebarWidth}
            minWidthPx={SIDEBAR_DOCK_MIN_WIDTH_PX}
            maxWidthPx={sidebarMaxWidthPx}
            resizeEdge="right"
            onDragWidthPx={handleSidebarWidthDrag}
            onCommitWidthPx={handleSidebarWidthCommit}
        >
            <View
                style={{ flex: 1, flexShrink: 0, minHeight: 0 }}
                {...(Platform.OS === 'web'
                    ? { onWheel: stopScrollEventPropagationOnWeb, onTouchMove: stopScrollEventPropagationOnWeb }
                    : {})}
            >
                <SidebarView
                    sidebarWidthPx={sidebarWidth}
                    desktopUpdateIndicator={props.desktopUpdateIndicator}
                />
            </View>
        </ResizableDockedPane>
    );

    // A sidebar is presentation, not a second navigator. Keep the root Stack and its
    // ancestry mounted through resize, auth changes, and chrome-bypass routes.
    return (
        <DesktopMainContentDragSurface
            enabled={showSidebar && Platform.OS === 'web' && isTauriDesktop()}
            leftOffsetPx={sidebarWidth}
            style={[styles.root, showSidebar && styles.canvas]}
        >
            {showSidebar ? (
                <View testID="navigation-sidebar" style={{ width: sidebarWidth, flexShrink: 0 }}>
                    {sidebar}
                </View>
            ) : null}
            <View key="route-content" style={[styles.content, showSidebar && styles.contentSheet]}>
                <Stack screenOptions={stackNavigationOptions} />
            </View>
            {Platform.OS === 'web' && showSidebar ? (
                <View
                    pointerEvents="none"
                    style={[styles.contentSheetSeamShadow, { left: sidebarWidth }]}
                />
            ) : null}
        </DesktopMainContentDragSurface>
    );
});
