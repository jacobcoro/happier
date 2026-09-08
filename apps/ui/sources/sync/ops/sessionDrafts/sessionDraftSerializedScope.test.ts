import { describe, expect, it } from 'vitest';
import { mergeSerializedSessionDraftScope } from './sessionDraftSerializedScope';

const scope = (replicas: Record<string, unknown>, v: 1 | 2 = 2) => JSON.stringify({ v, replicas });
const read = (raw: string | undefined) => JSON.parse(raw ?? '{"v":2,"replicas":{}}').replicas;

describe('serialized draft scope updates', () => {
    it('creates the first scope and preserves an untouched empty scope', () => {
        const next = scope({ a: { text: 'first draft' } });
        expect(read(mergeSerializedSessionDraftScope(undefined, undefined, next))).toEqual(read(next));
        expect(mergeSerializedSessionDraftScope(undefined, undefined, undefined)).toBeUndefined();
    });

    it('preserves and safely updates the predecessor ordinary-entry pointer and unknown envelope fields', () => {
        const envelope = (ordinaryEntryDraftId: string | null, text: string) => JSON.stringify({
            v: 2, ordinaryEntryDraftId, replicas: { a: { text } },
        });
        const previous = envelope('draft-a', 'before');
        const current = JSON.stringify({ ...JSON.parse(envelope('draft-b', 'before')), futureField: { keep: true } });
        expect(JSON.parse(mergeSerializedSessionDraftScope(current, previous, envelope('draft-a', 'edited'))!)).toEqual({
            v: 2, ordinaryEntryDraftId: 'draft-b', futureField: { keep: true }, replicas: { a: { text: 'edited' } },
        });
        expect(JSON.parse(mergeSerializedSessionDraftScope(previous, previous, envelope('draft-b', 'before'))!).ordinaryEntryDraftId).toBe('draft-b');
        expect(JSON.parse(mergeSerializedSessionDraftScope(previous, previous, envelope(null, 'before'))!).ordinaryEntryDraftId).toBeNull();
        expect(() => mergeSerializedSessionDraftScope(current, previous, envelope('draft-c', 'before'))).toThrow();
        // A consumer that does not own the predecessor field omits it without clearing it.
        expect(JSON.parse(mergeSerializedSessionDraftScope(current, previous, scope({ a: { text: 'edited' } }))!).ordinaryEntryDraftId).toBe('draft-b');
    });

    it('updates only locally changed drafts and preserves concurrent unrelated edits and additions', () => {
        const previous = scope({ a: { text: 'a1' }, b: { text: 'b1' } });
        const current = scope({ a: { text: 'a1' }, b: { text: 'b2' }, c: { text: 'c1' } });
        const next = scope({ a: { text: 'a2' }, b: { text: 'b1' } });
        expect(read(mergeSerializedSessionDraftScope(current, previous, next))).toEqual({
            a: { text: 'a2' }, b: { text: 'b2' }, c: { text: 'c1' },
        });
    });

    it('rejects a stale edit to the same draft and accepts an already committed retry', () => {
        const previous = scope({ a: { text: 'original' } });
        const current = scope({ a: { text: 'other tab' } });
        const next = scope({ a: { text: 'my edit' } });
        expect(() => mergeSerializedSessionDraftScope(current, previous, next)).toThrow();
        expect(read(mergeSerializedSessionDraftScope(next, previous, next))).toEqual(read(next));
    });

    it('deletes only locally removed drafts and rejects deletion of a concurrently edited draft', () => {
        const previous = scope({ a: { text: 'a1' } });
        const current = scope({ a: { text: 'a1' }, b: { text: 'other draft' } });
        expect(read(mergeSerializedSessionDraftScope(current, previous, undefined))).toEqual({ b: { text: 'other draft' } });
        expect(() => mergeSerializedSessionDraftScope(scope({ a: { text: 'newer' } }), previous, undefined)).toThrow();
    });

    it.each(['composer', 'routing', 'authoring', 'extension'] as const)('does not mistake v1/v2 duplicate omission for a local edit: %s', (kind) => {
        const field = { mutationId: 'm1', value: 'draft' };
        const path = kind === 'composer' ? { kind, field: 'text' }
            : kind === 'routing' ? { kind, field: 'recipient' }
                : kind === 'authoring' ? { kind, fieldId: 'directory' }
                    : { kind, pluginId: 'plugin', fieldId: 'custom' };
        const document = {
            composer: { text: field },
            target: kind === 'authoring'
                ? { kind: 'newSession', authoring: { directory: field } }
                : { kind: 'session', routing: { recipient: field } },
            extensions: { plugin: { custom: field } },
        };
        const oldReplica = { localRawDocument: document, baseRawDocument: document, pendingFieldMutations: [{ path, field, mutationId: 'm1' }] };
        const compactReplica = { localRawDocument: document, pendingFieldMutations: [{ path, mutationId: 'm1' }] };
        const previous = scope({ a: oldReplica, b: { text: 'b1' } }, 1);
        const current = scope({ a: { text: 'newer a' }, b: { text: 'b1' } });
        const next = scope({ a: compactReplica, b: { text: 'b2' } });
        expect(read(mergeSerializedSessionDraftScope(current, previous, next))).toEqual({
            a: { text: 'newer a' }, b: { text: 'b2' },
        });
    });

    it('preserves unfamiliar stored envelopes by refusing to overwrite them', () => {
        for (const current of ['broken JSON', '{"v":99,"replicas":{}}', '{"v":2,"replicas":[]}']) {
            expect(() => mergeSerializedSessionDraftScope(current, undefined, scope({ a: {} }))).toThrow();
        }
    });
});
