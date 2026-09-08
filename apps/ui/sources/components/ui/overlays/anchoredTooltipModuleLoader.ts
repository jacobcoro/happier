import type AnchoredTooltip from './AnchoredTooltip';

export type AnchoredTooltipComponent = typeof AnchoredTooltip;

/** Browser chunk loading is the external boundary; callers own retry and failure containment. */
export async function loadAnchoredTooltipComponent(): Promise<AnchoredTooltipComponent> {
    return (await import('./AnchoredTooltip')).default;
}
