import { resolvePermissionIntentFromSessionMetadata } from '../sessionControls/metadata.js';
import type { PermissionIntent } from '../types.js';
import {
    resolveNearestPermissionModeAtOrBelow as resolveProtocolPermissionMode,
    resolvePermissionPrivilegeOrdinal as resolveProtocolPermissionPrivilegeOrdinal,
    type PermissionPrivilegeOrdinal,
} from '@happier-dev/protocol';

import { parsePermissionIntentAlias } from './index.js';

export type { PermissionPrivilegeOrdinal } from '@happier-dev/protocol';

export type PermissionEscalationDecision =
    | {
        ok: true;
        requestedMode: string;
        requestedOrdinal: PermissionPrivilegeOrdinal;
        callerMode: string;
        callerOrdinal: PermissionPrivilegeOrdinal;
    }
    | {
        ok: false;
        reason: 'permission_escalation_denied';
        requestedMode: string;
        requestedOrdinal: PermissionPrivilegeOrdinal;
        callerMode: string;
        callerOrdinal: PermissionPrivilegeOrdinal;
    };

export type ResolvedPermissionPrivilege = Readonly<{
    mode: PermissionIntent;
    ordinal: PermissionPrivilegeOrdinal;
}>;

function isProvidedMode(rawMode: unknown): rawMode is string {
    return typeof rawMode === 'string' && rawMode.trim().length > 0;
}

function resolvePermissionPrivilege(rawMode: unknown): ResolvedPermissionPrivilege | null {
    if (!isProvidedMode(rawMode)) return null;
    const mode = parsePermissionIntentAlias(rawMode);
    if (!mode) return null;
    const ordinal = resolveProtocolPermissionPrivilegeOrdinal(mode);
    if (ordinal === null) return null;
    return {
        mode,
        ordinal,
    };
}

function resolveCallerPermissionPrivilege(rawMode: unknown): ResolvedPermissionPrivilege {
    return resolvePermissionPrivilege(rawMode) ?? {
        mode: 'default',
        ordinal: 1,
    };
}

export function resolvePermissionPrivilegeOrdinal(rawMode: unknown): PermissionPrivilegeOrdinal | null {
    return resolveProtocolPermissionPrivilegeOrdinal(rawMode);
}

export function resolvePermissionPrivilegeFromSessionMetadata(metadata: unknown): ResolvedPermissionPrivilege {
    const resolved = resolvePermissionIntentFromSessionMetadata(metadata);
    return resolveCallerPermissionPrivilege(resolved?.intent);
}

function toPermissionIntent(rawMode: string): PermissionIntent {
    return parsePermissionIntentAlias(rawMode) ?? 'default';
}

export function resolveNearestPermissionModeAtOrBelow(params: Readonly<{
    requestedMode: unknown;
    callerMode: unknown;
    callerSurface?: unknown;
    supportedModes?: readonly string[];
}>): PermissionEscalationDecision {
    const explicitRequested = resolvePermissionPrivilege(params.requestedMode);
    const decision = resolveProtocolPermissionMode({
        requestedMode: explicitRequested?.mode,
        callerMode: params.callerMode,
        callerSurface: params.callerSurface,
        supportedModes: params.supportedModes,
    });
    if (!decision.ok && decision.reason === 'invalid_parameters') {
        return resolveNearestPermissionModeAtOrBelow({
            ...params,
            requestedMode: undefined,
        });
    }
    const callerMode = toPermissionIntent(decision.callerMode);
    const requestedMode = toPermissionIntent(decision.normalizedMode);
    return decision.ok
        ? {
            ok: true,
            requestedMode,
            requestedOrdinal: decision.requestedOrdinal,
            callerMode,
            callerOrdinal: decision.callerOrdinal,
        }
        : {
            ok: false,
            reason: 'permission_escalation_denied',
            requestedMode,
            requestedOrdinal: decision.requestedOrdinal,
            callerMode,
            callerOrdinal: decision.callerOrdinal,
        };
}

export function assertNonEscalatingPermissionMode(params: Readonly<{
    requestedMode: unknown;
    callerMode: unknown;
    callerSurface?: unknown;
    supportedModes?: readonly string[];
}>): PermissionEscalationDecision {
    return resolveNearestPermissionModeAtOrBelow(params);
}
