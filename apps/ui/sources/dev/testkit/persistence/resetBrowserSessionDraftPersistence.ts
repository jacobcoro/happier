/**
 * Clears the real browser draft repository and makes its current module instance ready for use.
 *
 * The imports deliberately stay inside the function: suites that call `vi.resetModules()` must
 * reset the same persistence singleton that their subsequently imported production code will use.
 */
export async function resetBrowserSessionDraftPersistenceForTest(): Promise<void> {
    const [browserRecords, draftPersistence] = await Promise.all([
        import('@/sync/domains/state/browserRecordStorage'),
        import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage'),
    ]);

    await draftPersistence.discardSessionDraftPersistenceWrites();
    await browserRecords.clearBrowserRecords();
    // Bind the repository singleton to this post-reset storage module before it can be read.
    await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
    await draftPersistence.prepareSessionDraftPersistenceStorage();
}
