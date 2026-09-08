import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { useFilesystemTreeKeyboard, type FilesystemTreeKeyboardNode } from './useFilesystemTreeKeyboard';

const folder = { path: 'src', depth: 0, type: 'directory', isExpanded: false } as const;
const file = { path: 'src/index.ts', depth: 1, type: 'file', isExpanded: false } as const;
const other = { path: 'readme.md', depth: 0, type: 'file', isExpanded: false } as const;

describe('filesystem tree keyboard', () => {
    it('expands, traverses children, returns to parent and retains one active row after collapse', async () => {
        const activate = vi.fn();
        const pin = vi.fn();
        const hook = await renderHook((nodes: readonly FilesystemTreeKeyboardNode[]) => useFilesystemTreeKeyboard(nodes), { initialProps: [folder, other] as readonly FilesystemTreeKeyboardNode[] });
        const key = async (node: FilesystemTreeKeyboardNode, value: string, shiftKey = false) => {
            await act(async () => hook.getCurrent().getRowProps(node, activate, pin).onKeyDown?.({ key: value, shiftKey, preventDefault: vi.fn() }));
        };
        expect(hook.getCurrent().getRowProps(folder, activate).accessibilityState).toEqual({ expanded: false });
        await key(folder, 'ArrowRight');
        expect(activate).toHaveBeenCalledOnce();
        const expanded = { ...folder, isExpanded: true };
        await hook.rerender([expanded, file, other]);
        await key(expanded, 'ArrowRight');
        expect(hook.getCurrent().getRowProps(file, activate).webTabIndex).toBe(0);
        expect(hook.getCurrent().getRowProps(file, activate).accessibilityLevel).toBe(2);
        await key(file, 'p');
        expect(pin).toHaveBeenCalledOnce();
        const printDefault = vi.fn();
        await act(async () => hook.getCurrent().getRowProps(file, activate, pin).onKeyDown?.({ key: 'p', ctrlKey: true, preventDefault: printDefault }));
        expect(pin).toHaveBeenCalledOnce();
        expect(printDefault).not.toHaveBeenCalled();
        const enterDefault = vi.fn();
        await act(async () => hook.getCurrent().getRowProps(file, activate, pin).onKeyDown?.({ key: 'Enter', preventDefault: enterDefault }));
        expect(enterDefault).not.toHaveBeenCalled();
        expect(pin).toHaveBeenCalledOnce();
        expect(activate).toHaveBeenCalledOnce();
        await key(file, 'ArrowLeft');
        expect(hook.getCurrent().getRowProps(expanded, activate).webTabIndex).toBe(0);
        await key(expanded, 'ArrowDown');
        await hook.rerender([folder, other]);
        expect(hook.getCurrent().getRowProps(folder, activate).webTabIndex).toBe(0);
        expect(hook.getCurrent().getRowProps(other, activate).webTabIndex).toBe(-1);
        await key(folder, 'End');
        expect(hook.getCurrent().getRowProps(other, activate).webTabIndex).toBe(0);
    });
});
