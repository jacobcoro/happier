import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

const legacy = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => ({
    MMKV: class {
        getString(key: string) { return legacy.get(key); }
        set(key: string, value: string) { legacy.set(key, value); }
        delete(key: string) { legacy.delete(key); }
        getAllKeys() { return [...legacy.keys()]; }
        clearAll() { legacy.clear(); }
    },
}));

describe('clearPersistence storage lifecycle', () => {
    let platform: typeof import('react-native').Platform;
    let originalPlatform: typeof platform.OS;

    beforeEach(async () => {
        legacy.clear();
        vi.resetModules();
        vi.stubGlobal('indexedDB', new IDBFactory());
        platform = (await import('react-native')).Platform;
        originalPlatform = platform.OS;
    });

    afterEach(() => {
        Object.defineProperty(platform, 'OS', { configurable: true, value: originalPlatform });
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('keeps native clearing synchronous without browser storage', async () => {
        Object.defineProperty(platform, 'OS', { configurable: true, value: 'ios' });
        vi.stubGlobal('indexedDB', undefined);
        legacy.set('settings', 'native settings');
        const { clearPersistence } = await import('./persistence');
        const completion = clearPersistence();
        expect(legacy.size).toBe(0);
        await completion;
    });

    it('clears durable browser records and pending draft writes before completing', async () => {
        Object.defineProperty(platform, 'OS', { configurable: true, value: 'web' });
        const records = await import('./browserRecordStorage');
        const drafts = await import('../../ops/sessionDrafts/sessionDraftPersistenceStorage');
        const storage = drafts.getSessionDraftPersistenceStorage();
        if (!('prepare' in storage)) throw new Error('Expected browser storage');
        await storage.prepare();
        legacy.set('settings', 'browser settings');
        await records.writeBrowserRecord('session-pending-outbox-v1:test', 'pending outbox');
        storage.set('session-drafts-repository-v1:test', '{"v":2,"replicas":{}}');
        const writing = storage.flush();
        const { clearPersistence } = await import('./persistence');
        await clearPersistence();
        await writing;
        await storage.flush();
        expect(await records.listBrowserRecords('')).toEqual(new Map());
        expect(storage.getString('session-drafts-repository-v1:test')).toBeUndefined();
        expect(legacy.size).toBe(0);
    });
});
