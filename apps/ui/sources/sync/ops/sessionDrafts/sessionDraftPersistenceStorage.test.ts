import { describe, expect, it } from 'vitest';
import { createSessionDraftPersistenceStorage } from './sessionDraftPersistenceStorage';

const scopeKey = 'session-drafts-repository-v1:scope';
const record = (text: string) => JSON.stringify({ v: 2, replicas: { draft: { text } } });

function setup() {
    const legacy = new Map<string, string>([[scopeKey, record('valuable draft')]]);
    const durable = new Map<string, string>();
    let fail = false;
    let writes = 0;
    const storage = createSessionDraftPersistenceStorage({
        legacy: {
            getAllKeys: () => [...legacy.keys()],
            getString: (key) => legacy.get(key),
            delete: (key) => { legacy.delete(key); },
        },
        records: {
            list: async () => new Map(durable),
            update: async (key, update) => {
                if (fail) throw new Error('disk full');
                writes++;
                const next = update(durable.get(key));
                if (next.value === undefined) durable.delete(key);
                else durable.set(key, next.value);
                return next.result;
            },
        },
    });
    return { storage, legacy, durable, setFail: (value: boolean) => { fail = value; }, writes: () => writes };
}

describe('browser draft persistence', () => {
    it('discards queued autosaves during explicit data clearing instead of writing them back afterwards', async () => {
        const env = setup();
        await env.storage.prepare();
        env.storage.set(scopeKey, record('queued before logout'));
        await env.storage.discardPendingWrites();
        env.durable.clear();
        await env.storage.flush();
        expect(env.durable.size).toBe(0);
        expect(env.storage.getString(scopeKey)).toBeUndefined();
    });
    it('retains legacy drafts until migration commits and refuses premature empty reads', async () => {
        const env = setup();
        expect(() => env.storage.getString('session-drafts-repository-v1:scope')).toThrow();
        env.setFail(true);
        await expect(env.storage.prepare()).rejects.toThrow('disk full');
        expect(env.legacy.size).toBe(1);
        env.setFail(false);
        await env.storage.prepare();
        expect(env.storage.getString(scopeKey)).toBe(record('valuable draft'));
        expect(env.durable.get(scopeKey)).toBe(record('valuable draft'));
        expect(env.legacy.size).toBe(0);
    });

    it('coalesces input writes, surfaces failed durability, and retains the latest value for retry', async () => {
        const env = setup();
        await env.storage.prepare();
        env.setFail(true);
        env.storage.set(scopeKey, record('first'));
        env.storage.set(scopeKey, record('latest'));
        await expect(env.storage.flush()).rejects.toThrow('disk full');
        expect(env.storage.getString(scopeKey)).toBe(record('latest'));
        expect(env.durable.get(scopeKey)).toBe(record('valuable draft'));
        env.setFail(false);
        await env.storage.flush();
        expect(env.durable.get(scopeKey)).toBe(record('latest'));
        expect(env.writes()).toBe(2);
    });

    it('refuses to hide a divergent legacy draft when IndexedDB already contains another edit', async () => {
        const env = setup();
        env.durable.set(scopeKey, record('newer draft'));
        await expect(env.storage.prepare()).rejects.toThrow();
        expect(env.durable.get(scopeKey)).toBe(record('newer draft'));
        expect(env.legacy.get(scopeKey)).toBe(record('valuable draft'));
    });

    it('does not expose an unrecognized committed record as an empty draft scope', async () => {
        const env = setup();
        env.legacy.clear();
        env.durable.set(scopeKey, '{"v":99,"replicas":{}}');
        await expect(env.storage.prepare()).rejects.toThrow();
        expect(env.durable.get(scopeKey)).toBe('{"v":99,"replicas":{}}');
    });

    it('preserves another tab edit when the scope was cached before its first use', async () => {
        const env = setup();
        await env.storage.prepare();
        env.durable.set(scopeKey, record('other tab edit'));
        env.storage.set(scopeKey, record('my stale edit'));
        await expect(env.storage.flush()).rejects.toThrow();
        expect(env.durable.get(scopeKey)).toBe(record('other tab edit'));
        expect(env.storage.getString(scopeKey)).toBe(record('my stale edit'));
    });

    it('keeps unrelated concurrent drafts across repeated writes from a cached scope', async () => {
        const env = setup();
        await env.storage.prepare();
        env.durable.set(scopeKey, JSON.stringify({ v: 2, replicas: { draft: { text: 'valuable draft' }, other: { text: 'another tab' } } }));
        env.storage.set(scopeKey, record('first edit'));
        await env.storage.flush();
        env.storage.set(scopeKey, record('second edit'));
        await env.storage.flush();
        expect(JSON.parse(env.durable.get(scopeKey)!)).toEqual({ v: 2, replicas: { draft: { text: 'second edit' }, other: { text: 'another tab' } } });
    });
});
