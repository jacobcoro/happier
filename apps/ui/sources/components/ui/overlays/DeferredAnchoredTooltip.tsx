import * as React from 'react';

import { loadAnchoredTooltipComponent, type AnchoredTooltipComponent } from './anchoredTooltipModuleLoader';

type DeferredAnchoredTooltipProps = React.ComponentProps<AnchoredTooltipComponent> & Readonly<{
    /** Existing trigger interaction state; a later hover/focus retries a failed fetch. */
    activationKey: string;
}>;

/** Optional tooltip loading stays local; the module loader owns successful import caching. */
export function DeferredAnchoredTooltip({ activationKey, ...tooltipProps }: DeferredAnchoredTooltipProps) {
    const [Component, setComponent] = React.useState<AnchoredTooltipComponent | null>(null);
    React.useEffect(() => {
        if (Component) return;
        let active = true;
        void loadAnchoredTooltipComponent().then(
            (component) => { if (active) setComponent(() => component); },
            (error: unknown) => { console.warn('[Tooltip] Failed to load tooltip', error); },
        );
        return () => { active = false; };
    }, [activationKey, Component]);
    return Component ? <Component {...tooltipProps} /> : null;
}
