import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { runAppBootSequence, type AppBootReadyState } from './runAppBootSequence';

type Deferred<T> = Readonly<{
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
}>;

function createDeferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

const CREDENTIALS: AuthCredentials = { token: 'token-1', secret: 'secret-1' };

describe('runAppBootSequence', () => {
    it.each(['authenticated', 'signed-out', 'deferred'] as const)('waits for authoritative drafts before restore or first paint: %s', async (mode) => {
        const drafts = createDeferred<void>();
        const credentials = createDeferred<AuthCredentials | null>();
        const events: string[] = [];
        const run = runAppBootSequence({
            loadFonts: async () => {},
            sodiumReady: Promise.resolve(),
            resolveCredentials: () => mode === 'deferred' ? credentials.promise : Promise.resolve(mode === 'authenticated' ? CREDENTIALS : null),
            prepareWarmCache: async () => {},
            prepareSessionDrafts: () => drafts.promise,
            restoreSync: async () => { events.push('restore'); },
            onReady: () => { events.push('ready'); },
        });
        await vi.runAllTimersAsync();
        expect(events).toEqual([]);
        drafts.resolve();
        await vi.advanceTimersByTimeAsync(0);
        if (mode === 'deferred') credentials.resolve(CREDENTIALS);
        await run;
        expect(events).toEqual(mode === 'authenticated' ? ['restore', 'ready'] : mode === 'deferred' ? ['ready', 'restore', 'ready'] : ['ready']);
    });

    it('rejects failed authoritative draft preparation without restoring or painting empty state', async () => {
        const failure = new Error('IndexedDB unavailable');
        const events: string[] = [];
        await expect(runAppBootSequence({
            loadFonts: async () => {},
            sodiumReady: Promise.resolve(),
            resolveCredentials: async () => CREDENTIALS,
            prepareWarmCache: async () => {},
            prepareSessionDrafts: async () => { throw failure; },
            restoreSync: async () => { events.push('restore'); },
            onReady: () => { events.push('ready'); },
        })).rejects.toBe(failure);
        expect(events).toEqual([]);
    });

    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('starts fonts, crypto and the credential read together instead of chaining them', async () => {
        const fonts = createDeferred<void>();
        const sodium = createDeferred<void>();
        const started: string[] = [];

        const run = runAppBootSequence({
            loadFonts: () => {
                started.push('fonts');
                return fonts.promise;
            },
            sodiumReady: (() => {
                started.push('sodium');
                return sodium.promise;
            })(),
            resolveCredentials: async () => {
                started.push('credentials');
                return CREDENTIALS;
            },
            prepareWarmCache: async () => {},
            prepareSessionDrafts: async () => {},
            restoreSync: async () => {},
            onReady: () => {},
            fontLoadTimeoutMs: 5_000,
            credentialResolutionTimeoutMs: 5_000,
        });

        // Fonts are still pending, so every other leg being in flight is what proves the gate does
        // not chain them.
        await vi.advanceTimersByTimeAsync(0);
        expect([...started].sort()).toEqual(['credentials', 'fonts', 'sodium']);

        fonts.resolve();
        sodium.resolve();
        await run;
    });

    it('reaches first paint when the native font load never settles', async () => {
        const fonts = createDeferred<void>();
        const ready: AppBootReadyState[] = [];

        const run = runAppBootSequence({
            loadFonts: () => fonts.promise,
            sodiumReady: Promise.resolve(),
            resolveCredentials: async () => CREDENTIALS,
            prepareWarmCache: async () => {},
            prepareSessionDrafts: async () => {},
            restoreSync: async () => {},
            onReady: (state) => ready.push(state),
            fontLoadTimeoutMs: 500,
            credentialResolutionTimeoutMs: 500,
        });

        await vi.advanceTimersByTimeAsync(600);
        await run;

        expect(ready).toEqual([{ credentials: CREDENTIALS, authGeneration: 0 }]);
    });

    it('reaches first paint when the keychain read never settles, without reporting a signed-out user', async () => {
        const credentials = createDeferred<AuthCredentials | null>();
        const ready: AppBootReadyState[] = [];
        const restored: AuthCredentials[] = [];

        const run = runAppBootSequence({
            loadFonts: async () => {},
            sodiumReady: Promise.resolve(),
            resolveCredentials: () => credentials.promise,
            prepareWarmCache: async () => {},
            prepareSessionDrafts: async () => {},
            restoreSync: async (value) => {
                restored.push(value);
            },
            onReady: (state) => ready.push(state),
            fontLoadTimeoutMs: 500,
            credentialResolutionTimeoutMs: 500,
        });

        await vi.advanceTimersByTimeAsync(600);
        expect(ready).toEqual([{ credentials: null, authGeneration: 0 }]);
        expect(restored).toEqual([]);

        // The slow keychain finally answers: the session must be restored, not silently lost.
        credentials.resolve(CREDENTIALS);
        await run;

        expect(restored).toEqual([CREDENTIALS]);
        expect(ready).toEqual([
            { credentials: null, authGeneration: 0 },
            { credentials: CREDENTIALS, authGeneration: 1 },
        ]);
    });

    it('does not re-key auth when a deferred keychain read confirms there is no session', async () => {
        const credentials = createDeferred<AuthCredentials | null>();
        const ready: AppBootReadyState[] = [];

        const run = runAppBootSequence({
            loadFonts: async () => {},
            sodiumReady: Promise.resolve(),
            resolveCredentials: () => credentials.promise,
            prepareWarmCache: async () => {},
            prepareSessionDrafts: async () => {},
            restoreSync: async () => {},
            onReady: (state) => ready.push(state),
            fontLoadTimeoutMs: 500,
            credentialResolutionTimeoutMs: 500,
        });

        await vi.advanceTimersByTimeAsync(600);
        credentials.resolve(null);
        await run;

        expect(ready).toEqual([{ credentials: null, authGeneration: 0 }]);
    });

    it('hydrates sync before first paint so the warm cache still paints real content', async () => {
        const order: string[] = [];

        await runAppBootSequence({
            loadFonts: async () => {},
            sodiumReady: Promise.resolve(),
            resolveCredentials: async () => CREDENTIALS,
            prepareWarmCache: async () => {},
            prepareSessionDrafts: async () => {},
            restoreSync: async () => {
                order.push('restore');
            },
            onReady: () => order.push('ready'),
        });

        expect(order).toEqual(['restore', 'ready']);
    });

    it('boots with the resolved session when a font load fails outright', async () => {
        const ready: AppBootReadyState[] = [];

        await runAppBootSequence({
            loadFonts: async () => {
                throw new Error('font asset missing');
            },
            sodiumReady: Promise.resolve(),
            resolveCredentials: async () => CREDENTIALS,
            prepareWarmCache: async () => {},
            prepareSessionDrafts: async () => {},
            restoreSync: async () => {},
            onReady: (state) => ready.push(state),
        });

        expect(ready).toEqual([{ credentials: CREDENTIALS, authGeneration: 0 }]);
    });

    it('boots when sync restore fails so a broken restore cannot hold the splash screen', async () => {
        const ready: AppBootReadyState[] = [];

        await runAppBootSequence({
            loadFonts: async () => {},
            sodiumReady: Promise.resolve(),
            resolveCredentials: async () => CREDENTIALS,
            prepareWarmCache: async () => {},
            prepareSessionDrafts: async () => {},
            restoreSync: async () => {
                throw new Error('restore failed');
            },
            onReady: (state) => ready.push(state),
        });

        expect(ready).toEqual([{ credentials: CREDENTIALS, authGeneration: 0 }]);
    });

    it('settles the warm cache key before restoring sync, alongside the credential read', async () => {
        const warmCacheKey = createDeferred<void>();
        const order: string[] = [];
        const started: string[] = [];

        const run = runAppBootSequence({
            loadFonts: async () => {},
            sodiumReady: Promise.resolve(),
            resolveCredentials: async () => {
                started.push('credentials');
                return CREDENTIALS;
            },
            prepareSessionDrafts: async () => {},
            prepareWarmCache: () => {
                started.push('warm-cache-key');
                return warmCacheKey.promise;
            },
            restoreSync: async () => {
                order.push('restore');
            },
            onReady: () => order.push('ready'),
        });

        // Both keystore reads are in flight together, so the key normally costs nothing on top of
        // the credential read the boot already pays for.
        await vi.advanceTimersByTimeAsync(0);
        expect([...started].sort()).toEqual(['credentials', 'warm-cache-key']);
        // Restore reads the cache synchronously: starting it before the key lands would hydrate
        // nothing and paint an empty list.
        expect(order).toEqual([]);

        warmCacheKey.resolve();
        await run;
        expect(order).toEqual(['restore', 'ready']);
    });

    it('paints cold rather than holding the splash when the warm cache key never settles', async () => {
        const order: string[] = [];

        const run = runAppBootSequence({
            loadFonts: async () => {},
            sodiumReady: Promise.resolve(),
            resolveCredentials: async () => CREDENTIALS,
            prepareWarmCache: () => new Promise<void>(() => {}),
            prepareSessionDrafts: async () => {},
            restoreSync: async () => {
                order.push('restore');
            },
            onReady: () => order.push('ready'),
            warmCacheKeyTimeoutMs: 1_000,
        });

        await vi.advanceTimersByTimeAsync(999);
        expect(order).toEqual([]);

        await vi.advanceTimersByTimeAsync(1);
        await run;
        expect(order).toEqual(['restore', 'ready']);
    });
});
