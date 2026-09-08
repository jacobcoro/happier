import { Platform } from 'react-native';
import { getPersistenceStorage } from '@/sync/domains/state/persistence';
import { listBrowserRecords, updateBrowserRecord } from '@/sync/domains/state/browserRecordStorage';
import { mergeSerializedSessionDraftScope, parseSerializedSessionDraftScope } from './sessionDraftSerializedScope';

const PREFIX = 'session-drafts-repository-v1:';

type RecordUpdate = (current: string | undefined) => { value: string | undefined; result: string | undefined };
type Dependencies = {
    legacy: { getAllKeys(): string[]; getString(key: string): string | undefined; delete(key: string): void };
    records: { list(): Promise<Map<string, string>>; update(key: string, update: RecordUpdate): Promise<string | undefined> };
};

export function createSessionDraftPersistenceStorage({ legacy, records }: Dependencies) {
    const values = new Map<string, string>();
    const dirty = new Map<string, string | undefined>();
    const previousRequested = new Map<string, string>();
    let ready = false;
    let preparation: Promise<void> | undefined;
    let flushing: Promise<void> | undefined;

    function assertReady() {
        if (!ready) throw new Error('Draft storage has not finished loading. Your saved drafts have not been discarded.');
    }

    async function prepare(): Promise<void> {
        if (ready) return;
        if (preparation) return preparation;
        preparation = (async () => {
            const stored = await records.list();
            for (const value of stored.values()) {
                if (!parseSerializedSessionDraftScope(value)) {
                    throw new Error('Unrecognized draft storage format. Stored drafts were preserved.');
                }
            }
            for (const key of legacy.getAllKeys().filter((key) => key.startsWith(PREFIX))) {
                const previous = legacy.getString(key);
                if (previous === undefined) continue;
                const committed = await records.update(key, (current) => {
                    const value = mergeSerializedSessionDraftScope(current, undefined, previous);
                    return { value, result: value };
                });
                if (committed !== undefined) stored.set(key, committed);
                // The canonical merge either imported this value losslessly or rejected.
                if (legacy.getString(key) === previous) legacy.delete(key);
            }
            values.clear();
            previousRequested.clear();
            for (const [key, value] of stored) {
                values.set(key, value);
                previousRequested.set(key, value);
            }
            ready = true;
        })().finally(() => { preparation = undefined; });
        return preparation;
    }

    async function flush(): Promise<void> {
        assertReady();
        if (flushing) {
            await flushing;
            if (dirty.size) await flush();
            return;
        }
        flushing = (async () => {
            while (dirty.size) {
                const [key, value] = dirty.entries().next().value!;
                const merged = await records.update(key, (current) => {
                    const previous = previousRequested.get(key);
                    // Prepared records were validated, and the repository is the only writer.
                    // Avoid parsing/re-encoding every large draft on uncontended keystrokes.
                    const mergedValue = current === previous
                        ? value
                        : mergeSerializedSessionDraftScope(current, previous, value);
                    return { value: mergedValue, result: mergedValue };
                });
                // Keep the caller's view as the next delta baseline. Unseen records from another
                // tab must not become implicit deletions in a later serialized caller snapshot.
                if (value === undefined) previousRequested.delete(key);
                else previousRequested.set(key, value);
                if (dirty.get(key) === value) {
                    dirty.delete(key);
                    if (merged === undefined) values.delete(key);
                    else values.set(key, merged);
                }
            }
        })().finally(() => { flushing = undefined; });
        return flushing;
    }

    function change(key: string, value: string | undefined) {
        assertReady();
        if (value === undefined) values.delete(key);
        else values.set(key, value);
        dirty.set(key, value);
        // The repository owns autosave scheduling and publishes durability failures to subscribers.
    }

    return {
        getString: (key: string) => { assertReady(); return values.get(key); },
        set: (key: string, value: string) => change(key, value),
        delete: (key: string) => change(key, undefined),
        prepare,
        flush,
        discardPendingWrites: async () => {
            // Explicit local-data clearing may discard failed writes, unlike normal autosave.
            await preparation?.catch(() => {});
            dirty.clear();
            await flushing?.catch(() => {});
            dirty.clear();
            values.clear();
            previousRequested.clear();
        },
    };
}

let browserStorage: ReturnType<typeof createSessionDraftPersistenceStorage> | undefined;

export function getSessionDraftPersistenceStorage() {
    if (Platform.OS !== 'web') return getPersistenceStorage();
    browserStorage ??= createSessionDraftPersistenceStorage({
        legacy: getPersistenceStorage(),
        records: {
            list: () => listBrowserRecords(PREFIX),
            update: updateBrowserRecord,
        },
    });
    return browserStorage;
}

export async function prepareSessionDraftPersistenceStorage(): Promise<void> {
    const storage = getSessionDraftPersistenceStorage();
    if ('prepare' in storage) await storage.prepare();
}

export async function discardSessionDraftPersistenceWrites(): Promise<void> {
    await browserStorage?.discardPendingWrites();
}
