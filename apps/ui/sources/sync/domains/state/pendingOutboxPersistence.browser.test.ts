import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { scopedSessionLocalStateKey } from './sessionLocalStateKeys';

const legacy = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => ({
    MMKV: class {
        getString(key: string) { return legacy.get(key); }
        set(key: string, value: string) { legacy.set(key, value); }
        delete(key: string) { legacy.delete(key); }
        getAllKeys() { return [...legacy.keys()]; }
    },
}));

const scope = { serverId: 'server-browser', accountId: 'account-browser' } as const;
const key = scopedSessionLocalStateKey('session-pending-outbox-v1', scope);
function message(localId: string) {
    return {
        sessionId: 'session-browser', localId, createdAt: 1, text: localId, rawRecord: {},
        request: { v: 1 as const, body: JSON.stringify({ localId, messageRole: 'user', content: { t: 'plain', v: {} } }) },
    };
}

describe('browser pending outbox custody', () => {
    let platform: typeof import('react-native').Platform;
    let originalPlatform: typeof platform.OS;
    beforeEach(async () => {
        legacy.clear();
        vi.resetModules();
        vi.stubGlobal('indexedDB', new IDBFactory());
        platform = (await import('react-native')).Platform;
        originalPlatform = platform.OS;
        Object.defineProperty(platform, 'OS', { configurable: true, value: 'web' });
    });
    afterEach(() => {
        Object.defineProperty(platform, 'OS', { configurable: true, value: originalPlatform });
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('commits concurrent enqueues atomically and recovers them after the module is reloaded', async () => {
        const outbox = await import('./pendingOutboxPersistence');
        await Promise.all([outbox.savePendingOutboxMessage(message('a'), scope), outbox.savePendingOutboxMessage(message('b'), scope)]);
        expect(legacy.size).toBe(0);
        vi.resetModules();
        platform = (await import('react-native')).Platform;
        Object.defineProperty(platform, 'OS', { configurable: true, value: 'web' });
        const recovered = await import('./pendingOutboxPersistence');
        expect((await recovered.loadPendingOutboxForSession('session-browser', scope)).map(row => row.localId).sort()).toEqual(['a', 'b']);
        await recovered.markPendingOutboxMessageCancelRequested('session-browser', 'a', scope);
        await recovered.removePendingOutboxMessage('session-browser', 'a', scope, 'enqueue');
        await recovered.removePendingOutboxMessage('session-browser', 'b', scope);
        expect(await recovered.loadPendingOutboxForSession('session-browser', scope)).toEqual([expect.objectContaining({ localId: 'a', operation: 'cancel' })]);
    });

    it('retains legacy custody when the IndexedDB transaction aborts and imports it after retry', async () => {
        const raw = JSON.stringify({ 'session-browser': [message('legacy')] });
        legacy.set(key, raw);
        const outbox = await import('./pendingOutboxPersistence');
        const originalPut = IDBObjectStore.prototype.put;
        vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(function (this: IDBObjectStore, ...args) {
            const request = originalPut.apply(this, args);
            this.transaction.abort();
            return request;
        });
        await expect(outbox.loadPendingOutbox(scope)).rejects.toThrow();
        expect(legacy.get(key)).toBe(raw);
        expect(await outbox.loadPendingOutboxForSession('session-browser', scope)).toEqual([expect.objectContaining({ localId: 'legacy' })]);
        expect(legacy.has(key)).toBe(false);
    });

    it('fails closed when IndexedDB is unavailable and preserves the legacy bytes', async () => {
        legacy.set(key, '{unreadable custody');
        vi.stubGlobal('indexedDB', undefined);
        const outbox = await import('./pendingOutboxPersistence');
        await expect(outbox.savePendingOutboxMessage(message('new'), scope)).rejects.toThrow();
        expect(legacy.get(key)).toBe('{unreadable custody');
    });

    it('preserves corrupt IndexedDB bytes and keeps account scopes isolated', async () => {
        const records = await import('./browserRecordStorage');
        await records.writeBrowserRecord(key, '{corrupt custody');
        const outbox = await import('./pendingOutboxPersistence');
        await expect(outbox.savePendingOutboxMessage(message('new'), scope)).rejects.toThrow();
        const otherScope = { ...scope, accountId: 'another-account' };
        await outbox.savePendingOutboxMessage(message('other'), otherScope);
        expect(await records.readBrowserRecord(key)).toBe('{corrupt custody');
        expect(await outbox.listPendingOutboxSessionIds(otherScope)).toEqual(['session-browser']);
    });

    it('preserves both divergent browser and legacy copies and reports a scope conflict', async () => {
        const records = await import('./browserRecordStorage');
        const current = JSON.stringify({ 'session-browser': [message('current')] });
        const previous = JSON.stringify({ 'session-browser': [message('legacy')] });
        await records.writeBrowserRecord(key, current);
        legacy.set(key, previous);
        const outbox = await import('./pendingOutboxPersistence');
        await expect(outbox.loadPendingOutbox(scope)).rejects.toMatchObject({ code: 'pending_outbox_storage_conflict' });
        await expect(outbox.savePendingOutboxMessage(message('new'), scope)).rejects.toMatchObject({ code: 'pending_outbox_storage_conflict' });
        expect(await records.readBrowserRecord(key)).toBe(current);
        expect(legacy.get(key)).toBe(previous);
    });
});
