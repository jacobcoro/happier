const DAY_MS = 24 * 60 * 60 * 1000;
const RELATIVE_END_WINDOW_DAYS = 30;

export type SubscriptionEndTime = Readonly<{
    kind: 'relativeDays';
    days: number;
} | {
    kind: 'absoluteDate';
    date: string;
}>;

/**
 * Uses a day-granular countdown while a subscription ends within the next
 * month. Longer-lived (or already elapsed) subscriptions retain their date.
 */
export function resolveSubscriptionEndTime(params: Readonly<{
    nowMs: number;
    endAtMs: number;
    formatDate: (endAtMs: number) => string;
}>): SubscriptionEndTime {
    const deltaMs = params.endAtMs - params.nowMs;
    if (Number.isFinite(deltaMs) && deltaMs > 0 && deltaMs < RELATIVE_END_WINDOW_DAYS * DAY_MS) {
        return {
            kind: 'relativeDays',
            days: Math.max(1, Math.ceil(deltaMs / DAY_MS)),
        };
    }
    return {
        kind: 'absoluteDate',
        date: params.formatDate(params.endAtMs),
    };
}
