import { describe, expect, it } from 'vitest';
import * as subscriptionModule from './accountSubscription.js';

describe('subscription observation merge', () => {
  it('preserves successful observation freshness on failure and clears it only on a later successful observation', () => {
    const previous = { status: 'subscribed', renewal: 'off', observedAtMs: 100, staleAfterMs: 500, currentPeriodEndAtMs: 900 } as const;
    const incoming = { status: 'unavailable', renewal: 'unknown', observedAtMs: 200, staleAfterMs: 500, lastRefreshError: { observedAtMs: 200, code: 'network' } } as const;
    const merge = (subscriptionModule as unknown as { mergeProviderAccountSubscription: (a: unknown, b: unknown) => unknown }).mergeProviderAccountSubscription;
    expect(typeof merge).toBe('function');
    const failed = merge(previous, incoming);
    expect(failed).toEqual({ ...previous, lastRefreshError: incoming.lastRefreshError });
    expect(merge(failed, { ...previous, observedAtMs: 150 })).toEqual(failed);
    expect(merge(failed, { status: 'none', renewal: 'unknown', observedAtMs: 300, staleAfterMs: 500 })).toEqual({ status: 'none', renewal: 'unknown', observedAtMs: 300, staleAfterMs: 500 });
    expect(merge(previous, undefined)).toEqual(previous);
  });
});
