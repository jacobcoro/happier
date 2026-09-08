import * as React from 'react';
import type { ItemProps } from '@/components/ui/lists/Item';

export type FilesystemTreeKeyboardNode = Readonly<{ path: string; depth: number; type: string; isExpanded: boolean }>;
type FocusTarget = { focus?: () => void; ownerDocument?: { activeElement: unknown } };

/** One keyboard/focus owner for filesystem trees and their changed-file projection. */
export function useFilesystemTreeKeyboard(nodes: readonly FilesystemTreeKeyboardNode[], onFocusIndex?: (index: number) => void) {
    const [focusedPath, setFocusedPath] = React.useState<string | null>(null);
    const targets = React.useRef(new Map<string, FocusTarget>());
    const pendingFocus = React.useRef<string | null>(null);
    const navigable = React.useMemo(() => nodes.filter(node => node.type !== 'info'), [nodes]);
    const activePath = navigable.some(node => node.path === focusedPath)
        ? focusedPath
        : navigable.slice().reverse().find(node => focusedPath?.startsWith(`${node.path}/`) && node.type === 'directory')?.path ?? navigable[0]?.path ?? null;
    const focusPath = React.useCallback((path: string) => {
        setFocusedPath(path);
        pendingFocus.current = path;
        const target = targets.current.get(path);
        if (target) { target.focus?.(); pendingFocus.current = null; }
        else onFocusIndex?.(nodes.findIndex(node => node.path === path));
    }, [nodes, onFocusIndex]);
    React.useEffect(() => {
        if (focusedPath && activePath && focusedPath !== activePath) {
            if (pendingFocus.current === focusedPath) focusPath(activePath);
            else setFocusedPath(activePath);
        }
    }, [activePath, focusedPath, focusPath]);

    const getRowProps = React.useCallback((node: FilesystemTreeKeyboardNode, activate?: () => void, pin?: () => void): Pick<ItemProps, 'webRole' | 'webTabIndex' | 'accessibilityLevel' | 'webKeyShortcuts' | 'accessibilityState' | 'focusRef' | 'onFocus' | 'onKeyDown'> => ({
        webRole: 'treeitem',
        webKeyShortcuts: pin ? 'P' : undefined,
        webTabIndex: node.path === activePath ? 0 : -1,
        accessibilityLevel: node.depth + 1,
        accessibilityState: node.type === 'directory' ? { expanded: node.isExpanded } : undefined,
        focusRef: target => {
            if (!target) {
                const previous = targets.current.get(node.path);
                if (previous && previous.ownerDocument?.activeElement === previous) pendingFocus.current = node.path;
                targets.current.delete(node.path);
                return;
            }
            targets.current.set(node.path, target);
            if (pendingFocus.current === node.path) { target.focus?.(); pendingFocus.current = null; }
        },
        onFocus: () => setFocusedPath(node.path),
        onKeyDown: event => {
            if (event.ctrlKey || event.metaKey || event.altKey) return;
            if (event.target && event.currentTarget && event.target !== event.currentTarget) return;
            const key = event.nativeEvent?.key ?? event.key;
            const index = navigable.findIndex(entry => entry.path === node.path);
            let next: FilesystemTreeKeyboardNode | undefined;
            if (key === 'ArrowDown') next = navigable[index + 1];
            else if (key === 'ArrowUp') next = navigable[index - 1];
            else if (key === 'Home') next = navigable[0];
            else if (key === 'End') next = navigable[navigable.length - 1];
            else if (key === 'ArrowRight') {
                if (node.type === 'directory' && !node.isExpanded) activate?.();
                else if (node.type === 'directory' && navigable[index + 1]?.depth > node.depth) next = navigable[index + 1];
            } else if (key === 'ArrowLeft') {
                if (node.type === 'directory' && node.isExpanded) activate?.();
                else next = navigable.slice(0, index).reverse().find(entry => entry.depth < node.depth);
            } else if ((key === 'p' || key === 'P') && pin) pin();
            else return; // Plain Enter remains owned by Pressable, avoiding double activation.
            event.preventDefault?.();
            if (next) focusPath(next.path);
        },
    }), [activePath, focusPath, navigable]);
    return { activePath, getRowProps, focusPath };
}
