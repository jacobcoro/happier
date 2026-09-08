import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import {
    ConnectedServiceQuotaSnapshotV1Schema,
    type ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import type { UseConnectedServiceQuotaSnapshotResult } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSnapshot';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW_MS = 1_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('react-native-svg', () => ({
    SvgXml: (props: Record<string, unknown>) => React.createElement('SvgXml', props),
    // The capacity-ring avatar renders an SVG ring (Svg + Circle).
    Svg: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Svg', props, props.children),
    Circle: (props: Record<string, unknown>) => React.createElement('Circle', props, null),
}));

vi.mock('react-native-gesture-handler', async () => {
    const { createGestureHandlerMock } = await import('@/dev/testkit/mocks/gestureHandler');
    return createGestureHandlerMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

const reducedMotionRef = vi.hoisted(() => ({ value: true }));
vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => reducedMotionRef.value,
}));

const modalState = vi.hoisted(() => ({ confirmResult: true, confirmSpy: vi.fn() }));
vi.mock('@/modal', () => ({
    Modal: {
        confirm: (...args: unknown[]) => {
            modalState.confirmSpy(...args);
            return Promise.resolve(modalState.confirmResult);
        },
    },
}));

const featureState = vi.hoisted(() => ({ quotasEnabled: true, subscriptionEnabled: false }));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) =>
        featureId === 'connectedServices.quotas' ? featureState.quotasEnabled
            : featureId === 'connectedServices.subscription' ? featureState.subscriptionEnabled : true,
}));

const quotaHookState = vi.hoisted(() => ({
    callSpy: vi.fn(),
    value: null as unknown,
}));
vi.mock('@/hooks/server/connectedServices/useConnectedServiceQuotaSnapshot', () => ({
    useConnectedServiceQuotaSnapshot: (params: unknown) => {
        quotaHookState.callSpy(params);
        return quotaHookState.value;
    },
}));

const settingsState = vi.hoisted(() => ({
    collapsed: {} as Record<string, boolean>,
    writes: [] as Array<Record<string, boolean>>,
}));
vi.mock('@/sync/store/hooks', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/store/hooks')>();
    const ReactModule = await import('react');
    return {
        ...actual,
        useSettingMutable: (key: string) => {
            const [value, setValue] = ReactModule.useState(() => settingsState.collapsed);
            const setter = (next: Record<string, boolean>) => {
                settingsState.writes.push(next);
                settingsState.collapsed = next;
                setValue(next);
            };
            return [value, setter];
        },
    };
});

function buildSnapshot(overrides: Partial<ConnectedServiceQuotaSnapshotV1> = {}): ConnectedServiceQuotaSnapshotV1 {
    return ConnectedServiceQuotaSnapshotV1Schema.parse({
        v: 1,
        serviceId: 'anthropic',
        profileId: 'work',
        fetchedAt: NOW_MS - 1000,
        staleAfterMs: 60_000,
        planLabel: 'Pro',
        accountLabel: null,
        recoveryCredits: {
            kind: 'usage_limit_resets',
            availableCount: 1,
            nextExpiresAtMs: NOW_MS + 3 * DAY_MS,
            credits: [
                { kind: 'usage_limit_reset', status: 'available', providerCreditId: 'pc-1', expiresAtMs: NOW_MS + 3 * DAY_MS },
            ],
        },
        meters: [
            { meterId: 'weekly', label: 'Weekly', used: 82, limit: 100, unit: 'count', utilizationPct: null, resetsAt: null, status: 'ok', details: {} },
        ],
        ...overrides,
    });
}

function buildQuotaResult(overrides: Partial<UseConnectedServiceQuotaSnapshotResult> = {}): UseConnectedServiceQuotaSnapshotResult {
    return {
        snapshot: buildSnapshot(),
        loading: false,
        error: null,
        isStale: false,
        nowMs: NOW_MS,
        recoveryCreditSummary: { availableCount: 1, nextExpiresAtMs: NOW_MS + 3 * DAY_MS, providerCreditId: 'pc-1' },
        recoveryCreditMachineId: 'machine-1',
        canConsumeRecoveryCredit: true,
        canRefresh: true,
        isRefreshing: false,
        refresh: vi.fn(async () => {}),
        consumeRecoveryCredit: vi.fn(async () => {}),
        consumeRecoveryCreditPending: false,
        consumeRecoveryCreditPendingTarget: null,
        pinnedMeterIds: [],
        togglePinnedMeter: vi.fn(),
        ...overrides,
    };
}

beforeEach(() => {
    reducedMotionRef.value = true;
    modalState.confirmResult = true;
    modalState.confirmSpy.mockClear();
    featureState.quotasEnabled = true;
    quotaHookState.callSpy.mockClear();
    quotaHookState.value = buildQuotaResult();
    settingsState.collapsed = {};
    settingsState.writes = [];
});

afterEach(() => {
    vi.clearAllMocks();
});

/** Build a pan reorder gesture via the gesture-handler mock to bind a handle. */
async function makeReorderGesture() {
    const { Gesture } = await import('react-native-gesture-handler');
    return Gesture.Pan();
}

async function renderAccountBlock(props: Partial<React.ComponentProps<typeof import('./AccountBlock')['AccountBlock']>> = {}) {
    const { AccountBlock } = await import('./AccountBlock');
    return renderScreen(
        <AccountBlock
            testID="acct"
            serviceId="anthropic"
            profileId="work"
            title="Work"
            status="connected"
            {...props}
        />,
    );
}

describe('AccountBlock', () => {
    it('renders a calm collapsed meta line (resets + pools counts) with capacity in the ring', async () => {
        settingsState.collapsed = { 'anthropic:account:work': true };
        const screen = await renderAccountBlock({ poolLabels: ['Team'] });

        // Per-limit usage now reads from the avatar's capacity rings (center number),
        // not from collapsed mini-meters.
        expect(screen.findByTestId('acct:avatar:capacity')).toBeTruthy();
        // Resets + pool membership are muted counts on the meta line (not pills/chips).
        expect(screen.findByTestId('acct:resets')).toBeTruthy();
        expect(screen.findByTestId('acct:pools-count')).toBeTruthy();
        // Collapsed: the expanded body Pools section is not rendered.
        expect(screen.findAllByTestId('acct:body-pools').length).toBe(0);
        expect(screen.findAllByTestId('acct:pools-label').length).toBe(0);
        // Collapsed: the expanded body sections are not rendered.
        expect(screen.getTextContent()).not.toContain('connectedServices.account.usageCaption');
    });

    it('shows a non-renewing subscription end date beside the reset count when collapsed', async () => {
        settingsState.collapsed = { 'anthropic:account:work': true };
        quotaHookState.value = buildQuotaResult({
            snapshot: buildSnapshot({
                subscription: {
                    status: 'subscribed',
                    renewal: 'off',
                    observedAtMs: NOW_MS,
                    staleAfterMs: 60_000,
                    currentPeriodEndAtMs: NOW_MS + 10 * DAY_MS,
                },
            }),
        });

        const screen = await renderAccountBlock();

        expect(screen.findByTestId('acct:subscription-end')).toBeTruthy();
        expect(screen.getTextContent()).toContain('connectedServices.subscription.endsInDays');
    });

    it('aligns subscription renewal status to the right of its heading and keeps the end date in body text', async () => {
        quotaHookState.value = buildQuotaResult({
            snapshot: buildSnapshot({
                subscription: {
                    status: 'subscribed',
                    renewal: 'off',
                    observedAtMs: NOW_MS,
                    staleAfterMs: 60_000,
                    currentPeriodEndAtMs: NOW_MS + 10 * DAY_MS,
                },
            }),
        });

        const screen = await renderAccountBlock();

        expect(screen.findByTestId('acct:subscription:header')).toBeTruthy();
        expect(screen.findByTestId('acct:subscription:renewal')).toBeTruthy();
        expect(screen.findByTestId('acct:subscription:period')).toBeTruthy();
        expect(screen.getTextContent()).toContain('connectedServices.subscription.renewalOff');
        expect(screen.getTextContent()).toContain('connectedServices.subscription.endsInDays');
    });

    it('moves pool membership into a labelled "Pools" section when expanded', async () => {
        // Detail variant defaults to expanded.
        const screen = await renderAccountBlock({ poolLabels: ['Team'] });

        // The collapsed meta line (with the pools count) is absent when expanded.
        expect(screen.findAllByTestId('acct:pools-count').length).toBe(0);
        // Expanded body carries the labelled Pools section with the membership chip.
        expect(screen.findByTestId('acct:body-pools')).toBeTruthy();
        expect(screen.findByTestId('acct:pools-label')).toBeTruthy();
        expect(screen.findByTestId('acct:body-pool-chip:0')).toBeTruthy();
        expect(screen.getTextContent()).toContain('connectedServices.account.poolsLabel');
    });

    it('shows a needs-re-auth badge in the header when the credential needs re-auth', async () => {
        settingsState.collapsed = { 'anthropic:account:work': true };
        const screen = await renderAccountBlock({ status: 'needs_reauth' });

        expect(screen.findByTestId('acct:reauth-badge')).toBeTruthy();
    });

    it('lets credential health dominate quota display and polling when re-auth is required', async () => {
        const screen = await renderAccountBlock({ status: 'needs_reauth' });

        expect(quotaHookState.callSpy).not.toHaveBeenCalled();
        expect(screen.findByTestId('acct:reauth-badge')).toBeTruthy();
        expect(screen.findAllByTestId('acct:meter:weekly')).toHaveLength(0);
        expect(screen.getTextContent()).not.toContain('connectedServices.account.usageCaption');
        expect(screen.findByTestId('acct:avatar:capacity')).toBeNull();
    });

    it('renders usage for a healthy account whose status is empty/unknown (fails OPEN)', async () => {
        // Regression: an absent status coerced to '' must NOT blank the capacity
        // avatar. Only an EXPLICIT needs_reauth hides usage; '' is presumed
        // healthy for display, so the snapshot hook mounts and quota renders.
        const screen = await renderAccountBlock({
            // Boundary cast: the runtime feed can carry an absent/coerced '' that
            // the enum-typed prop does not model; the display gate must fail open.
            status: '' as React.ComponentProps<typeof import('./AccountBlock')['AccountBlock']>['status'],
        });

        expect(quotaHookState.callSpy).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('acct:avatar:capacity')).toBeTruthy();
        expect(screen.findAllByTestId('acct:reauth-badge').length).toBe(0);
    });

    it('shows a default-account star glyph (not a pill) for the default account', async () => {
        const screen = await renderAccountBlock({ isDefault: true });
        expect(screen.findByTestId('acct:default-star')).toBeTruthy();
    });

    it('reveals USAGE and QUOTA RESETS sections when expanded', async () => {
        const screen = await renderAccountBlock();

        const text = screen.getTextContent();
        expect(text).toContain('connectedServices.account.usageCaption');
        expect(text).toContain('connectedServices.account.resetsCaption');
        expect(screen.findByTestId('acct:meter:weekly')).toBeTruthy();
        expect(screen.findByTestId('acct:reset-row:pc-1')).toBeTruthy();
        expect(screen.findByTestId('acct:reset-use:pc-1')).toBeTruthy();
    });

    it('confirms before consuming a reset and skips consume when cancelled', async () => {
        modalState.confirmResult = false;
        const quota = buildQuotaResult();
        quotaHookState.value = quota;
        const screen = await renderAccountBlock();

        await screen.pressByTestIdAsync('acct:reset-use:pc-1');

        expect(modalState.confirmSpy).toHaveBeenCalledTimes(1);
        expect(quota.consumeRecoveryCredit).not.toHaveBeenCalled();
    });

    it('consumes the reset through the hook after the confirm is accepted, threading THAT row credit id', async () => {
        modalState.confirmResult = true;
        const quota = buildQuotaResult();
        quotaHookState.value = quota;
        const screen = await renderAccountBlock();

        await screen.pressByTestIdAsync('acct:reset-use:pc-1');

        expect(modalState.confirmSpy).toHaveBeenCalledTimes(1);
        // Per-credit "Use": the row's own providerCreditId is forwarded so the
        // correct credit is redeemed (not just the summary default).
        expect(quota.consumeRecoveryCredit).toHaveBeenCalledTimes(1);
        expect(quota.consumeRecoveryCredit).toHaveBeenCalledWith('pc-1');
    });

    it('forwards a null credit id for the aggregate placeholder row (summary default)', async () => {
        modalState.confirmResult = true;
        const quota = buildQuotaResult({
            snapshot: buildSnapshot({
                recoveryCredits: {
                    kind: 'usage_limit_resets',
                    availableCount: 2,
                    nextExpiresAtMs: NOW_MS + 3 * DAY_MS,
                    // No detailed credits -> a single aggregate row consumed via the
                    // summary default (consumableCreditId: null).
                    credits: [],
                },
            }),
        });
        quotaHookState.value = quota;
        const screen = await renderAccountBlock();

        await screen.pressByTestIdAsync('acct:reset-use:aggregate');

        expect(quota.consumeRecoveryCredit).toHaveBeenCalledWith(null);
    });

    it('keeps non-selected reset rows readable while one credit is being consumed', async () => {
        quotaHookState.value = {
            ...buildQuotaResult({
                consumeRecoveryCreditPending: true,
                snapshot: buildSnapshot({
                    recoveryCredits: {
                        kind: 'usage_limit_resets',
                        availableCount: 2,
                        nextExpiresAtMs: NOW_MS + 3 * DAY_MS,
                        credits: [
                            { kind: 'usage_limit_reset', status: 'available', providerCreditId: 'pc-1', expiresAtMs: NOW_MS + 3 * DAY_MS },
                            { kind: 'usage_limit_reset', status: 'available', providerCreditId: 'pc-2', expiresAtMs: NOW_MS + 3 * DAY_MS },
                        ],
                    },
                }),
            }),
            consumeRecoveryCreditPendingTarget: { providerCreditId: 'pc-1' },
        } as UseConnectedServiceQuotaSnapshotResult;

        const screen = await renderAccountBlock();
        const secondRow = screen.findByTestId('acct:reset-row:pc-2');

        expect(secondRow?.findAll((node) =>
            node.children.includes('connectedServices.account.resets.use'),
        ).length).toBeGreaterThan(0);
    });

    it('keeps aggregate Use available when a detail cannot be consumed individually', async () => {
        const quota = buildQuotaResult({
            snapshot: buildSnapshot({
                recoveryCredits: {
                    kind: 'usage_limit_resets',
                    availableCount: 1,
                    nextExpiresAtMs: NOW_MS + 3 * DAY_MS,
                    // No providerCreditId: this detail must not suppress aggregate redemption.
                    credits: [{ kind: 'usage_limit_reset', status: 'available', expiresAtMs: NOW_MS + 3 * DAY_MS }],
                },
            }),
        });
        quotaHookState.value = quota;

        const screen = await renderAccountBlock();

        await screen.pressByTestIdAsync('acct:reset-use:aggregate-remainder');
        expect(quota.consumeRecoveryCredit).toHaveBeenCalledWith(null);
    });

    it('persists collapse state to connectedServicesCollapsedItemKeysV1 (sparse deviation)', async () => {
        const screen = await renderAccountBlock();

        // Account default is expanded -> toggling collapses it, persisting the deviation only.
        await screen.pressByTestIdAsync('acct:header');

        expect(settingsState.writes).toContainEqual({ 'anthropic:account:work': true });
    });

    it('toggles the pinned meter through the hook', async () => {
        const quota = buildQuotaResult();
        quotaHookState.value = quota;
        const screen = await renderAccountBlock();

        await screen.pressByTestIdAsync('acct:pin:weekly');

        expect(quota.togglePinnedMeter).toHaveBeenCalledWith('weekly');
    });

    it('fails closed when the quotas feature is disabled (no fetch, no usage)', async () => {
        featureState.quotasEnabled = false;
        const screen = await renderAccountBlock();

        expect(quotaHookState.callSpy).not.toHaveBeenCalled();
        expect(screen.getTextContent()).not.toContain('connectedServices.account.usageCaption');
        expect(screen.findAllByTestId('acct:meter:weekly').length).toBe(0);
    });

    it('shows a loading skeleton before the first snapshot resolves', async () => {
        quotaHookState.value = buildQuotaResult({ snapshot: null, loading: true });
        const screen = await renderAccountBlock();

        expect(screen.findByTestId('acct:usage-skeleton')).toBeTruthy();
        expect(screen.findAllByTestId('acct:meter:weekly').length).toBe(0);
    });

    it('shows a loading avatar (not an empty capacity ring) while the first snapshot loads', async () => {
        // Regression: a slow load previously rendered EMPTY rings + no center label,
        // which reads as "no usage". The avatar must surface a loading indicator and
        // suppress the numeric capacity until a snapshot resolves.
        quotaHookState.value = buildQuotaResult({ snapshot: null, loading: true });
        const screen = await renderAccountBlock();

        expect(screen.findByTestId('acct:avatar:loading')).toBeTruthy();
        expect(screen.findAllByTestId('acct:avatar:capacity').length).toBe(0);
    });

    it('shows quota errors inline without hiding the account row', async () => {
        quotaHookState.value = buildQuotaResult({
            snapshot: null,
            loading: false,
            error: 'quota load failed',
        });

        const screen = await renderAccountBlock();

        expect(screen.findByTestId('acct:header')).toBeTruthy();
        expect(screen.findByTestId('acct:quota-error')).toBeTruthy();
        expect(screen.getTextContent()).toContain('quota load failed');
    });

    it('shows the refresh-in-flight state and disables duplicate refresh presses', async () => {
        quotaHookState.value = buildQuotaResult({ isRefreshing: true });

        const screen = await renderAccountBlock();
        const refresh = screen.findByTestId('acct:refresh');

        expect(screen.findByTestId('acct:refreshing')).toBeTruthy();
        expect(refresh?.props.disabled).toBe(true);
        expect(refresh?.props.accessibilityState).toEqual(expect.objectContaining({
            busy: true,
            disabled: true,
        }));
    });

    it('invokes the quota refresh once per refresh-button press', async () => {
        const refresh = vi.fn(async () => {});
        quotaHookState.value = buildQuotaResult({ refresh });

        const screen = await renderAccountBlock();

        await screen.pressByTestIdAsync('acct:refresh');

        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('renders the account header as a group when the trailing refresh button is present', async () => {
        const screen = await renderAccountBlock();

        expect(screen.findByTestId('acct:header')?.props.role).toBe('group');
    });

    it('keeps reset credits visible but disabled when no target machine is resolved', async () => {
        quotaHookState.value = buildQuotaResult({ recoveryCreditMachineId: null });

        const screen = await renderAccountBlock();

        expect(screen.findByTestId('acct:resets-hint')).toBeTruthy();
        expect(screen.findByTestId('acct:reset-use:pc-1')?.props.disabled).toBe(true);
    });

    describe('poolMember variant', () => {
        it('renders collapsed by default with an inline reorder handle, enable switch, and capacity', async () => {
            const onToggleEnabled = vi.fn();
            const screen = await renderAccountBlock({
                variant: 'poolMember',
                groupId: 'g1',
                enabled: true,
                onToggleEnabled,
                reorderGesture: await makeReorderGesture(),
            });

            // Default-collapsed: body sections hidden.
            expect(screen.getTextContent()).not.toContain('connectedServices.account.usageCaption');
            // The handle is rendered INLINE inside the view (mirroring SessionItem),
            // bound to the supplied pan gesture via a GestureDetector.
            expect(screen.findByTestId('acct:reorder-handle')).toBeTruthy();
            // Capacity now lives in the ring avatar (its centered value).
            expect(screen.findByTestId('acct:avatar:capacity')).toBeTruthy();

            const enableSwitch = screen.findByTestId('acct:enable-toggle');
            expect(enableSwitch).toBeTruthy();
            enableSwitch?.props.onValueChange?.(false);
            expect(onToggleEnabled).toHaveBeenCalledWith(false);
        });

        it('shows the active-account radio and sets active from the list', async () => {
            const onSetActive = vi.fn();
            const screen = await renderAccountBlock({
                variant: 'poolMember',
                groupId: 'g1',
                enabled: true,
                isActive: false,
                onSetActive,
                reorderGesture: await makeReorderGesture(),
            });
            const radio = screen.findByTestId('acct:active-radio');
            expect(radio).toBeTruthy();
            expect(radio?.props.accessibilityState?.checked).toBe(false);
            radio?.props.onPress?.({});
            expect(onSetActive).toHaveBeenCalled();
        });

        it('marks the active member radio selected and non-interactive', async () => {
            const screen = await renderAccountBlock({
                variant: 'poolMember',
                groupId: 'g1',
                enabled: true,
                isActive: true,
                onSetActive: vi.fn(),
                reorderGesture: await makeReorderGesture(),
            });
            const radio = screen.findByTestId('acct:active-radio');
            expect(radio?.props.accessibilityState?.checked).toBe(true);
            expect(radio?.props.accessibilityState?.disabled).toBe(true);
        });

        it('renders the inline reorder handle in the trailing cluster and collapses member actions into a single kebab', async () => {
            const actions: ItemAction[] = [
                { id: 'act:move-up', title: 'Move up', icon: 'arrow-up', onPress: () => {} },
                { id: 'act:move-down', title: 'Move down', icon: 'arrow-down', onPress: () => {} },
                { id: 'act:set-active', title: 'Set active', icon: 'circle', onPress: () => {} },
            ];
            const screen = await renderAccountBlock({
                variant: 'poolMember',
                groupId: 'g1',
                enabled: true,
                onToggleEnabled: vi.fn(),
                reorderGesture: await makeReorderGesture(),
                actions,
            });

            // The handle now lives in the header's trailing cluster (rendered as
            // the header `Item`'s rightElement), i.e. it is a descendant of the
            // header row instead of a leading sibling in front of the row.
            const header = screen.findByTestId('acct:header');
            expect(header).toBeTruthy();
            expect(header?.findAll((node) => node.props?.testID === 'acct:reorder-handle').length).toBe(1);

            // Member actions collapse into one ⋮ overflow menu (kebab) rather
            // than inline icons on the row.
            expect(screen.findByTestId('acct:actions-menu')).toBeTruthy();

            // Move up / Move down / Set active are no longer inline on the row —
            // they live inside the (closed) kebab popover, so none are present.
            expect(screen.findAllByTestId('act:move-up').length).toBe(0);
            expect(screen.findAllByTestId('act:move-down').length).toBe(0);
            expect(screen.findAllByTestId('act:set-active').length).toBe(0);
        });
    });
});
