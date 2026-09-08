import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { ConnectedServiceQuotaGaugeViewModel } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';
import { renderScreen } from '@/dev/testkit';

import { AgentInputProviderUsageBadge } from './AgentInputProviderUsageBadge';

const tokenUsageRingRenderSpy = vi.hoisted(() => vi.fn());

vi.mock('@/components/sessions/usage', async () => {
    const ReactActual = await vi.importActual<typeof import('react')>('react');
    const ReactNative = await vi.importActual<typeof import('react-native')>('react-native');
    return {
        TokenUsageRing: (props: { value?: string; valueTestID?: string }) => {
            tokenUsageRingRenderSpy(props);
            return ReactActual.createElement(ReactNative.Text, { testID: props.valueTestID }, props.value);
        },
    };
});

function viewModel(): ConnectedServiceQuotaGaugeViewModel {
    return {
        serviceId: 'openai-codex',
        providerDisplayName: 'Codex',
        activeAccountDisplayLabel: 'Work account',
        remainingPct: 18,
        usedPct: 82,
        valueLabel: '18% left',
        ringValueLabel: '18',
        badgeLabel: '18% left',
        scopePrefix: null,
        primaryValueSemantics: 'remaining',
        detailRightLabel: '18% left · resets in 2h',
        usedLimitLabel: '82/100 used',
        resetLabel: '2h',
        tone: 'warning',
        isStale: false,
        recoveryCreditSummary: {
            availableCount: 1,
            nextExpiresAtMs: null,
            providerCreditId: null,
        },
        effectiveMeter: {
            meterId: 'weekly',
            label: 'Weekly',
            used: 82,
            limit: 100,
            unit: 'count',
            utilizationPct: null,
            resetsAt: 0,
            status: 'ok',
            details: {},
        },
        allMeterRows: [{
            meterId: 'weekly',
            label: 'Weekly',
            remainingPct: 18,
            usedPct: 82,
            detailRightSemantics: 'remaining',
            detailRightLabel: '18% left · resets in 2h',
            usedLimitSemantics: 'used',
            usedLimitLabel: '82/100 used',
            resetLabel: '2h',
            tone: 'warning',
        }],
    };
}

describe('AgentInputProviderUsageBadge', () => {
    it('keeps subscription details live while the usage popover remains open', async () => {
        const firstViewModel = {
            ...viewModel(),
            subscription: {
                summary: 'Renews 15 September',
                period: '15 August – 15 September',
                renewal: 'on' as const,
                renewalLabel: 'On',
                checkedLabel: 'Checked 1 minute ago',
                notice: null,
                accessUntilLabel: null,
                isLastKnown: false,
            },
        };
        const screen = await renderScreen(<AgentInputProviderUsageBadge viewModel={firstViewModel} />);
        act(() => screen.findByTestId('agent-input-provider-usage-badge')?.props.onPress?.());
        expect(screen.findByTestId('agent-input-provider-usage-subscription:renewal')?.props.children).toContain('On');
        await screen.update(<AgentInputProviderUsageBadge viewModel={{
            ...firstViewModel,
            subscription: { ...firstViewModel.subscription, renewal: 'off', renewalLabel: 'Off', summary: 'Ends 15 September' },
        }} />);
        expect(screen.findByTestId('agent-input-provider-usage-subscription:renewal')?.props.children).toContain('Off');
        await screen.update(<AgentInputProviderUsageBadge viewModel={viewModel()} />);
        expect(screen.findByTestId('agent-input-provider-usage-subscription')).toBeNull();
    });

    it('removes the duplicated top quota summary and keeps consistent group spacing', async () => {
        const firstViewModel = {
            ...viewModel(),
            subscription: {
                summary: 'Ends 15 September',
                period: null,
                renewal: 'off' as const,
                renewalLabel: 'Off',
                checkedLabel: 'Checked 1 minute ago',
                notice: null,
                accessUntilLabel: null,
                isLastKnown: false,
            },
        };
        const screen = await renderScreen(<AgentInputProviderUsageBadge viewModel={firstViewModel} />);
        act(() => screen.findByTestId('agent-input-provider-usage-badge')?.props.onPress?.());

        const quotaSummaryOccurrences = screen.getTextContent().split(firstViewModel.detailRightLabel).length - 1;
        expect(quotaSummaryOccurrences).toBe(1);
        expect(flattenStyle(screen.findByTestId('agent-input-provider-usage-subscription')?.props.style).gap).toBe(0);
        expect(flattenStyle(screen.findByTestId('agent-input-provider-usage-meter:weekly')?.props.style).marginTop).toBe(12);
    });

    it('does not rerender the ring when parent rerenders with the same gauge display data', async () => {
        tokenUsageRingRenderSpy.mockClear();
        const firstViewModel = viewModel();
        const screen = await renderScreen(
            <AgentInputProviderUsageBadge viewModel={firstViewModel} />,
        );

        await screen.update(
            <AgentInputProviderUsageBadge viewModel={{ ...firstViewModel }} />,
        );

        expect(tokenUsageRingRenderSpy).toHaveBeenCalledTimes(1);
        act(() => screen.tree.unmount());
    });

    it('shows recovery credits in the popover and applies them through the provided action', async () => {
        const onRecoveryCreditPress = vi.fn();
        const screen = await renderScreen(
            <AgentInputProviderUsageBadge
                viewModel={viewModel()}
                onRecoveryCreditPress={onRecoveryCreditPress}
            />,
        );

        act(() => {
            screen.findByTestId('agent-input-provider-usage-badge')?.props.onPress?.();
        });

        const meterFill = screen.findByTestId('agent-input-provider-usage-meter-bar:weekly:fill');
        // Remaining-first fill: the row label says "18% left", so the bar fills 18% (battery model;
        // user decision 2026-07-10 reverting the consumption-fill flip in 5ad4d06be).
        expect(flattenStyle(meterFill?.props.style).width).toBe('18%');

        expect(screen.getTextContent()).toContain('1 reset available');
        const action = screen.tree.root.findAll((node) => node.props?.testID === 'agent-input-provider-usage-recovery-credit-action')[0] ?? null;
        expect(action).toBeTruthy();

        act(() => {
            action?.props.onPress?.();
        });

        expect(onRecoveryCreditPress).toHaveBeenCalledTimes(1);
        act(() => screen.tree.unmount());
    });
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, entry) => ({ ...acc, ...flattenStyle(entry) }), {});
    }
    return typeof style === 'object' ? style as Record<string, unknown> : {};
}
