// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installCodeViewCommonModuleMocks } from '@/components/ui/code/view/codeViewTestHelpers';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({ useLocalSetting: () => 1 });
});
installCodeViewCommonModuleMocks({ reactNative: async () => import('react-native-web') });
afterEach(() => { vi.restoreAllMocks(); });

describe('raw file panel web scrolling', () => {
    it.each([true, false])('owns scrolling and retains the reading passage below the virtualization threshold, wrap=%s', async (wrapLines) => {
        const { FileContentPanel } = await import('./FileContentPanel');
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        const props = {
            theme: { colors: { text: { secondary: '#999' } } },
            displayMode: 'file' as const,
            sessionId: 's1', filePath: 'a.txt', diffContent: null, language: null,
            selectedLineKeys: new Set<string>(), lineSelectionEnabled: false,
            onToggleLine: vi.fn(), reviewCommentsEnabled: true,
            reviewCommentDrafts: [], scrollTestID: 'code-scroll', wrapLines,
        };
        const text = Array.from({ length: 360 }, (_, index) => `line ${index + 1}`).join('\n');
        let scroll: HTMLElement | null = null;
        // jsdom has no layout: geometry is the browser boundary; the panel/renderer remain real.
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            const rows = Array.from(host.querySelectorAll<HTMLElement>('[id*="-f:"]'));
            const index = rows.indexOf(this);
            const top = index >= 0 ? index * 20 - (scroll?.scrollTop ?? 0) : 0;
            const height = this === scroll ? 100 : index >= 0 ? 20 : 7200;
            return { top, bottom: top + height, height, width: 500, left: 0, right: 500, x: 0, y: top, toJSON() {} };
        });
        try {
            await act(async () => root.render(<FileContentPanel {...props} fileContent={text} />));
            scroll = host.querySelector<HTMLElement>('[data-testid="code-scroll"]');
            expect(scroll).not.toBeNull();
            Object.defineProperties(scroll!, { clientHeight: { value: 100 }, scrollHeight: { value: 7200 } });
            expect(getComputedStyle(scroll!).overflowY).toMatch(/auto|scroll/);
            scroll!.scrollTop = 4000;
            await act(async () => root.render(<FileContentPanel {...props} fileContent={`inserted\n${text}`} />));
            expect(host.querySelector('[data-testid="code-scroll"]')).toBe(scroll);
            expect(scroll!.scrollTop).toBe(4020);
        } finally {
            await act(async () => root.unmount());
            host.remove();
        }
    });
});
