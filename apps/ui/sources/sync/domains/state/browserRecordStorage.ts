/** Device-local large records. A successful write means the IndexedDB transaction committed. */
const DATABASE = 'happier-local-records';
const STORE = 'records';

let connection: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
    if (connection) return connection;
    connection = new Promise<IDBDatabase>((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('Browser storage is unavailable; local changes cannot be saved.'));
            return;
        }
        const request = indexedDB.open(DATABASE, 1);
        request.onupgradeneeded = () => {
            request.result.createObjectStore(STORE);
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('Browser storage upgrade is blocked by another tab.'));
        request.onsuccess = () => {
            const database = request.result;
            database.onversionchange = () => {
                database.close();
                connection = undefined;
            };
            resolve(database);
        };
    }).catch((error: unknown) => {
        connection = undefined;
        throw error;
    });
    return connection;
}

export async function readBrowserRecord(key: string): Promise<string | undefined> {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE, 'readonly');
        const request = transaction.objectStore(STORE).get(key);
        transaction.oncomplete = () => {
            if (request.result !== undefined && typeof request.result !== 'string') {
                reject(new Error('Invalid browser record; stored data was preserved.'));
            } else {
                resolve(request.result);
            }
        };
        transaction.onabort = () => reject(transaction.error ?? new Error('Browser record read aborted.'));
        transaction.onerror = () => reject(transaction.error);
    });
}

/** The synchronous callback runs within one transaction, including concurrent tabs. */
export async function updateBrowserRecord<T>(
    key: string,
    update: (current: string | undefined) => { value: string | undefined; result: T },
): Promise<T> {
    const database = await openDatabase();
    return new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(STORE, 'readwrite', { durability: 'strict' });
        const store = transaction.objectStore(STORE);
        const request = store.get(key);
        let result: T;
        request.onsuccess = () => {
            try {
                if (request.result !== undefined && typeof request.result !== 'string') {
                    throw new Error('Invalid browser record; stored data was preserved.');
                }
                const next = update(request.result);
                result = next.result;
                if (next.value === undefined) store.delete(key);
                else store.put(next.value, key);
            } catch (error) {
                transaction.abort();
                reject(error);
            }
        };
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = () => reject(transaction.error ?? new Error('Browser record write aborted.'));
        transaction.onerror = () => reject(transaction.error);
    });
}

export function writeBrowserRecord(key: string, value: string): Promise<void> {
    return updateBrowserRecord(key, () => ({ value, result: undefined }));
}

export function deleteBrowserRecord(key: string): Promise<void> {
    return updateBrowserRecord(key, () => ({ value: undefined, result: undefined }));
}

export async function clearBrowserRecords(): Promise<void> {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE, 'readwrite', { durability: 'strict' });
        transaction.objectStore(STORE).clear();
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? new Error('Browser record clear aborted.'));
        transaction.onerror = () => reject(transaction.error);
    });
}

export async function listBrowserRecords(prefix: string): Promise<Map<string, string>> {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE, 'readonly');
        const request = transaction.objectStore(STORE).openCursor();
        const records = new Map<string, string>();
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) {
                if (typeof cursor.value !== 'string') {
                    transaction.abort();
                    reject(new Error('Invalid browser record; stored data was preserved.'));
                    return;
                }
                records.set(cursor.key, cursor.value);
            }
            cursor.continue();
        };
        transaction.oncomplete = () => resolve(records);
        transaction.onabort = () => reject(transaction.error ?? new Error('Browser record listing aborted.'));
        transaction.onerror = () => reject(transaction.error);
    });
}
