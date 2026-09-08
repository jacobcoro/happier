import * as React from 'react';

const NO_PATHS: readonly string[] = [];

export function useRepositoryTreeRevealedPaths(scopeKey: string) {
    const [state, setState] = React.useState<Readonly<{ scopeKey: string; paths: readonly string[]; latestRequest?: Readonly<{ path: string }> }> | null>(null);
    const paths = state?.scopeKey === scopeKey ? state.paths : NO_PATHS;
    const revealPath = React.useCallback((path: string, options?: Readonly<{ focus: boolean }>) => {
        setState(previous => {
            const paths = previous?.scopeKey === scopeKey ? previous.paths : NO_PATHS;
            if (paths.includes(path) && !options?.focus) return previous;
            return {
                scopeKey,
                paths: paths.includes(path) ? paths : [...paths, path],
                latestRequest: options?.focus ? { path } : previous?.scopeKey === scopeKey ? previous.latestRequest : undefined,
            };
        });
    }, [scopeKey]);
    return { paths, revealPath, latestRequest: state?.scopeKey === scopeKey ? state.latestRequest : undefined };
}
