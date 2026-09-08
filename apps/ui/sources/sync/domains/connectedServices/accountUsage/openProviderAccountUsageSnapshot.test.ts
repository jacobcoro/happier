import { describe, expect, it } from 'vitest';
import { buildProviderAccountUsageRecordId, sealProviderAccountUsageSnapshot } from '@happier-dev/protocol';
import { encodeBase64 } from '@/encryption/base64';
import { openProviderAccountUsageSnapshot } from './openProviderAccountUsageSnapshot';

describe('openProviderAccountUsageSnapshot', () => {
  it('restores the independently sealed subscription observation without changing the base usage data', () => {
    const secret = new Uint8Array(32).fill(3);
    const recordKey = { providerId: 'codex', accountSubjectId: 'account', subjectKind: 'account', quotaScope: 'account' } as const;
    const snapshot = {
      v: 1 as const,
      recordId: buildProviderAccountUsageRecordId(recordKey),
      recordKey,
      providerId: 'codex',
      accountSubject: { kind: 'providerSubject' as const, id: 'account' },
      observedAtMs: 1_000,
      fetchedAtMs: 1_000,
      staleAfterMs: 60_000,
      source: 'providerHttp' as const,
      confidence: 'confirmed' as const,
      state: 'loaded_empty' as const,
      meters: [],
      subscription: { status: 'none' as const, renewal: 'unknown' as const, observedAtMs: 500, staleAfterMs: 300_000 },
    };
    const sealed = sealProviderAccountUsageSnapshot({
      material: { type: 'legacy', secret },
      snapshot,
      randomBytes: (length) => new Uint8Array(length).fill(9),
    });

    expect(openProviderAccountUsageSnapshot({ token: 't', secret: encodeBase64(secret, 'base64url') }, sealed)).toEqual(snapshot);
  });
});
