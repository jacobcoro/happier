import { describe, expect, it } from 'vitest';

import { resolveSubscriptionEndTime } from './resolveSubscriptionEndTime';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('resolveSubscriptionEndTime', () => {
    it('uses a rounded-up day countdown inside the next month', () => {
        expect(resolveSubscriptionEndTime({
            nowMs: 1_000,
            endAtMs: 1_000 + 23 * DAY_MS + 1,
            formatDate: () => 'absolute date',
        })).toEqual({ kind: 'relativeDays', days: 24 });
    });

    it('keeps an absolute date at or beyond the one-month boundary', () => {
        expect(resolveSubscriptionEndTime({
            nowMs: 1_000,
            endAtMs: 1_000 + 30 * DAY_MS,
            formatDate: () => 'absolute date',
        })).toEqual({ kind: 'absoluteDate', date: 'absolute date' });
    });
});
