import { resolveConnectedServiceProfileLabel } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { resolveConnectedServiceCredentialHealthStatus } from '@/sync/domains/connectedServices/resolveConnectedServiceCredentialHealthStatus';
import { t } from '@/text';
import {
    formatConnectedServiceIdentityVisibleLabel,
    resolveConnectedServiceProfileIdentityDisplay,
} from './resolveConnectedServiceIdentityDisplay';
import {
    ConnectedServiceAuthGroupPolicyV1Schema,
    type ConnectedServiceCredentialHealthStatusV1,
    type ConnectedServiceAuthGroupPolicyV1,
    type ConnectedServiceAuthGroupV1,
    type ConnectedServiceId,
} from '@happier-dev/protocol';

export type ConnectedServiceGroupMemberViewModel = Readonly<{
    profileId: string;
    enabled: boolean;
    priority: number;
    cooldownUntilMs: number | null;
    exhaustedUntilMs: number | null;
    quotaExhaustedUntilMs: number | null;
    rateLimitedUntilMs: number | null;
    capacityLimitedUntilMs: number | null;
    authInvalidUntilMs: number | null;
    planUnavailableUntilMs: number | null;
    validationBlockedUntilMs: number | null;
    lastObservedAtMs: number | null;
    lastFailureKind: string | null;
    readiness: ConnectedServiceGroupMemberReadiness;
    blocker: ConnectedServiceGroupMemberBlocker | null;
}>;

export type ConnectedServiceGroupMemberBlockerKind =
    | 'quota_exhausted'
    | 'rate_limited'
    | 'capacity_limited'
    | 'auth_invalid'
    | 'plan_unavailable'
    | 'validation_blocked'
    | 'exhausted'
    | 'cooldown';

export type ConnectedServiceGroupMemberReadiness =
    | 'ready'
    | 'disabled'
    | ConnectedServiceGroupMemberBlockerKind;

export type ConnectedServiceGroupMemberBlocker = Readonly<{
    kind: ConnectedServiceGroupMemberBlockerKind;
    untilMs: number;
}>;

export type ConnectedServiceGroupViewModel = Readonly<{
    groupId: string;
    label: string;
    activeProfileId: string;
    policy: ConnectedServiceAuthGroupPolicyV1;
    status: 'ready' | 'exhausted' | 'needs_members';
    cooldownUntilMs: number | null;
    generation: number;
    members: ReadonlyArray<ConnectedServiceGroupMemberViewModel>;
}>;

export type ConnectedServiceGroupProfileLike = Readonly<{
    profileId?: string;
    label?: string | null;
    providerEmail?: string | null;
    status?: unknown;
}>;

export const CONNECTED_SERVICE_GROUP_DEFAULT_POLICY: ConnectedServiceAuthGroupPolicyV1 = ConnectedServiceAuthGroupPolicyV1Schema.parse({});

const connectedServiceAuthGroupPolicyKeys = [
    'v',
    'strategy',
    'autoSwitch',
    'autoUseQuotaResetsWhenExhausted',
    'switchOn',
    'cooldownMs',
    'honorProviderResetsAt',
    'autoRestorePrimaryWhenReset',
    'maxSwitchesPerTurn',
    'maxSwitchesPerSessionHour',
    'softSwitchRemainingPercent',
    'probeIfSnapshotOlderThanMs',
    'preTurnProbeMode',
    'preTurnProbeOrder',
    'recoveryMode',
    'resumePromptMode',
] as const satisfies ReadonlyArray<keyof ConnectedServiceAuthGroupPolicyV1>;

function readRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

export function readConnectedServiceGroupString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

export function normalizeConnectedServiceGroupPolicy(
    value: unknown,
    fallbackRaw?: Readonly<Record<string, unknown>>,
): ConnectedServiceAuthGroupPolicyV1 {
    const raw = readRecord(value) ?? fallbackRaw ?? {};
    const direct = ConnectedServiceAuthGroupPolicyV1Schema.safeParse(raw);
    if (direct.success) return direct.data;

    const policyInput: Record<string, unknown> = {};
    for (const key of connectedServiceAuthGroupPolicyKeys) {
        if (Object.prototype.hasOwnProperty.call(raw, key)) {
            policyInput[key] = raw[key];
        }
    }

    const sanitized = ConnectedServiceAuthGroupPolicyV1Schema.safeParse(policyInput);
    if (sanitized.success) return sanitized.data;

    const rawStrategy = readConnectedServiceGroupString(raw.strategy);
    return {
        ...CONNECTED_SERVICE_GROUP_DEFAULT_POLICY,
        strategy: rawStrategy === 'least_limited' || rawStrategy === 'manual' ? rawStrategy : 'priority',
        autoSwitch: readBoolean(raw.autoSwitch, CONNECTED_SERVICE_GROUP_DEFAULT_POLICY.autoSwitch),
    };
}

export function normalizeConnectedServiceGroupMember(value: unknown): ConnectedServiceGroupMemberViewModel | null {
    const raw = readRecord(value);
    if (!raw) return null;
    const profileId = readConnectedServiceGroupString(raw.profileId);
    if (!profileId) return null;
    const state = readRecord(raw.state) ?? {};
    const enabled = raw.enabled !== false;
    const cooldownUntilMs = readNumber(state.cooldownUntilMs);
    const exhaustedUntilMs = readNumber(state.exhaustedUntilMs);
    const quotaExhaustedUntilMs = readNumber(state.quotaExhaustedUntilMs);
    const rateLimitedUntilMs = readNumber(state.rateLimitedUntilMs);
    const capacityLimitedUntilMs = readNumber(state.capacityLimitedUntilMs);
    const authInvalidUntilMs = readNumber(state.authInvalidUntilMs);
    const planUnavailableUntilMs = readNumber(state.planUnavailableUntilMs);
    const validationBlockedUntilMs = readNumber(state.validationBlockedUntilMs);
    const blocker = resolveConnectedServiceGroupMemberBlocker({
        authInvalidUntilMs,
        planUnavailableUntilMs,
        validationBlockedUntilMs,
        quotaExhaustedUntilMs,
        rateLimitedUntilMs,
        capacityLimitedUntilMs,
        exhaustedUntilMs,
        cooldownUntilMs,
    });
    return {
        profileId,
        enabled,
        priority: readNumber(raw.priority) ?? 100,
        cooldownUntilMs,
        exhaustedUntilMs,
        quotaExhaustedUntilMs,
        rateLimitedUntilMs,
        capacityLimitedUntilMs,
        authInvalidUntilMs,
        planUnavailableUntilMs,
        validationBlockedUntilMs,
        lastObservedAtMs: readNumber(state.lastObservedAtMs),
        lastFailureKind: readConnectedServiceGroupString(state.lastFailureKind) || null,
        readiness: !enabled ? 'disabled' : blocker?.kind ?? 'ready',
        blocker,
    };
}

function resolveConnectedServiceGroupMemberBlocker(params: Readonly<{
    authInvalidUntilMs: number | null;
    planUnavailableUntilMs: number | null;
    validationBlockedUntilMs: number | null;
    quotaExhaustedUntilMs: number | null;
    rateLimitedUntilMs: number | null;
    capacityLimitedUntilMs: number | null;
    exhaustedUntilMs: number | null;
    cooldownUntilMs: number | null;
}>): ConnectedServiceGroupMemberBlocker | null {
    const nowMs = Date.now();
    if (isFutureLimiter(params.authInvalidUntilMs, nowMs)) return { kind: 'auth_invalid', untilMs: params.authInvalidUntilMs };
    if (isFutureLimiter(params.planUnavailableUntilMs, nowMs)) return { kind: 'plan_unavailable', untilMs: params.planUnavailableUntilMs };
    if (isFutureLimiter(params.validationBlockedUntilMs, nowMs)) return { kind: 'validation_blocked', untilMs: params.validationBlockedUntilMs };
    if (isFutureLimiter(params.quotaExhaustedUntilMs, nowMs)) return { kind: 'quota_exhausted', untilMs: params.quotaExhaustedUntilMs };
    if (isFutureLimiter(params.rateLimitedUntilMs, nowMs)) return { kind: 'rate_limited', untilMs: params.rateLimitedUntilMs };
    if (isFutureLimiter(params.capacityLimitedUntilMs, nowMs)) return { kind: 'capacity_limited', untilMs: params.capacityLimitedUntilMs };
    if (isFutureLimiter(params.exhaustedUntilMs, nowMs)) return { kind: 'exhausted', untilMs: params.exhaustedUntilMs };
    if (isFutureLimiter(params.cooldownUntilMs, nowMs)) return { kind: 'cooldown', untilMs: params.cooldownUntilMs };
    return null;
}

function isFutureLimiter(value: number | null, nowMs: number): value is number {
    return value !== null && value > nowMs;
}

function readMembers(value: unknown): ConnectedServiceGroupMemberViewModel[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((member): ConnectedServiceGroupMemberViewModel[] => {
        const normalized = normalizeConnectedServiceGroupMember(member);
        return normalized ? [normalized] : [];
    });
}

export function createConnectedServiceGroupViewModel(value: unknown): ConnectedServiceGroupViewModel | null {
    const raw = readRecord(value);
    if (!raw) return null;
    const groupId = readConnectedServiceGroupString(raw.groupId);
    if (!groupId) return null;

    const state = readRecord(raw.state) ?? {};
    const members = readMembers(raw.members);
    const enabledCount = members.filter((member) => member.enabled).length;
    const rawStatus = readConnectedServiceGroupString(state.status) || readConnectedServiceGroupString(raw.status);
    const status = enabledCount <= 0
        ? 'needs_members'
        : rawStatus === 'exhausted'
            ? 'exhausted'
            : 'ready';

    return {
        groupId,
        label: readConnectedServiceGroupString(raw.displayName) || readConnectedServiceGroupString(raw.label) || groupId,
        activeProfileId: readConnectedServiceGroupString(raw.activeProfileId),
        policy: normalizeConnectedServiceGroupPolicy(raw.policy, raw),
        status,
        cooldownUntilMs: readNumber(state.cooldownUntilMs) ?? readNumber(raw.cooldownUntilMs),
        generation: readNumber(raw.generation) ?? 0,
        members,
    };
}

export function parseConnectedServiceGroupViewModels(groups: unknown): ConnectedServiceGroupViewModel[] {
    if (!Array.isArray(groups)) return [];
    return groups.flatMap((group): ConnectedServiceGroupViewModel[] => {
        const normalized = createConnectedServiceGroupViewModel(group);
        return normalized ? [normalized] : [];
    });
}

export function resolveConnectedServiceGroupMemberCredentialHealthStatus(params: Readonly<{
    member: Pick<ConnectedServiceGroupMemberViewModel, 'profileId' | 'blocker'>;
    profiles?: ReadonlyArray<ConnectedServiceGroupProfileLike>;
}>): ConnectedServiceCredentialHealthStatusV1 {
    const profile = params.profiles?.find((candidate) =>
        readConnectedServiceGroupString(candidate.profileId) === params.member.profileId
    ) ?? null;
    if (params.member.blocker?.kind === 'auth_invalid') return 'needs_reauth';
    if (profile && Object.prototype.hasOwnProperty.call(profile, 'status')) {
        return resolveConnectedServiceCredentialHealthStatus(profile.status);
    }
    return 'connected';
}

export type ConnectedServiceGroupIdentityResolver = Readonly<{
    serviceId: ConnectedServiceId;
    labelsByKey: Readonly<Record<string, string | undefined>>;
    profiles?: ReadonlyArray<ConnectedServiceGroupProfileLike>;
}>;

export type ConnectedServiceGroupMemberIdentity = Readonly<{
    label: string;
    id: string;
    hasDistinctId: boolean;
    secondaryLabel?: string;
    visibleLabel: string;
    diagnosticLabel: string;
}>;

/**
 * Canonical identity model for a connected-service group member. The display label is the primary
 * identity; the raw profile id is exposed as a secondary detail only when it differs from the label
 * (i.e. a label is actually configured). All group surfaces — the group-card subtitle, member-row
 * titles, and the active marker — resolve identity through this one helper so they never disagree.
 */
export function resolveConnectedServiceGroupMemberIdentity(params: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    labelsByKey: Readonly<Record<string, string | undefined>>;
    profiles?: ReadonlyArray<ConnectedServiceGroupProfileLike>;
}>): ConnectedServiceGroupMemberIdentity {
    const settingsLabel = resolveConnectedServiceProfileLabel({
        labelsByKey: params.labelsByKey,
        serviceId: params.serviceId,
        profileId: params.profileId,
    });
    const profile = params.profiles?.find((candidate) =>
        readConnectedServiceGroupString(candidate.profileId) === params.profileId
    ) ?? null;
    const display = resolveConnectedServiceProfileIdentityDisplay({
        profileId: params.profileId,
        label: settingsLabel ?? profile?.label ?? null,
        providerEmail: profile?.providerEmail ?? null,
    });

    return {
        label: display.primaryLabel,
        id: params.profileId,
        hasDistinctId: Boolean(display.secondaryLabel),
        ...(display.secondaryLabel ? { secondaryLabel: display.secondaryLabel } : {}),
        visibleLabel: formatConnectedServiceIdentityVisibleLabel(display),
        diagnosticLabel: display.diagnosticLabel,
    };
}

function formatConnectedServiceGroupIdentityText(
    profileId: string,
    identity: ConnectedServiceGroupIdentityResolver | undefined,
): string {
    if (!identity) return profileId;
    const resolved = resolveConnectedServiceGroupMemberIdentity({
        serviceId: identity.serviceId,
        profileId,
        labelsByKey: identity.labelsByKey,
        profiles: identity.profiles,
    });
    return resolved.visibleLabel;
}

export function formatConnectedServiceGroupSubtitle(
    group: ConnectedServiceGroupViewModel,
    identity?: ConnectedServiceGroupIdentityResolver,
): string {
    const enabledCount = group.members.filter((member) => member.enabled).length;
    const totalCount = group.members.length;
    const prioritySummary = [...group.members]
        .sort((a, b) => a.priority - b.priority)
        .map((member) => `${formatConnectedServiceGroupIdentityText(member.profileId, identity)}:${member.priority}`)
        .join(', ');

    const parts = [
        group.activeProfileId
            ? t('connectedServices.detail.groups.activeMember', {
                member: formatConnectedServiceGroupIdentityText(group.activeProfileId, identity),
            })
            : null,
        t('connectedServices.detail.groups.enabledMembers', { enabled: enabledCount, total: totalCount }),
        group.policy.autoSwitch
            ? t('connectedServices.detail.groups.autoFallbackEnabled')
            : t('connectedServices.detail.groups.autoFallbackDisabled'),
        group.policy.strategy === 'manual'
            ? t('connectedServices.detail.groups.strategyManual')
            : group.policy.strategy === 'least_limited'
                ? t('connectedServices.detail.groups.strategyLeastLimited')
                : t('connectedServices.detail.groups.strategyPriority'),
        prioritySummary
            ? t('connectedServices.detail.groups.priority', { priority: prioritySummary })
            : null,
        group.status === 'exhausted'
            ? t('connectedServices.detail.groups.statusExhausted')
            : group.status === 'needs_members'
                ? t('connectedServices.detail.groups.statusNeedsMembers')
                : t('connectedServices.detail.groups.statusReady'),
        group.cooldownUntilMs !== null
            ? t('connectedServices.detail.groups.cooldown', {
                time: new Date(group.cooldownUntilMs).toLocaleString(),
            })
            : null,
    ];
    return parts.filter(Boolean).join(' • ');
}

export function formatConnectedServiceGroupMemberSubtitle(
    member: ConnectedServiceGroupMemberViewModel,
    activeProfileId: string | null | undefined,
    identity?: ConnectedServiceGroupIdentityResolver,
): string {
    const resolvedIdentity = identity
        ? resolveConnectedServiceGroupMemberIdentity({
            serviceId: identity.serviceId,
            profileId: member.profileId,
            labelsByKey: identity.labelsByKey,
            profiles: identity.profiles,
        })
        : null;
    const parts = [
        resolvedIdentity?.secondaryLabel ?? null,
        member.profileId === activeProfileId ? t('connectedServices.detail.groups.memberActive') : null,
        member.enabled ? t('connectedServices.detail.groups.memberEnabled') : t('connectedServices.detail.groups.memberDisabled'),
        t('connectedServices.detail.groups.memberPriority', { priority: member.priority }),
        formatConnectedServiceGroupMemberBlocker(member.blocker),
        member.lastFailureKind
            ? t('connectedServices.detail.groups.memberLastFailure', { reason: member.lastFailureKind })
            : null,
    ];
    return parts.filter(Boolean).join(' • ');
}

function formatConnectedServiceGroupMemberBlocker(
    blocker: ConnectedServiceGroupMemberBlocker | null,
): string | null {
    if (!blocker) return null;
    const time = new Date(blocker.untilMs).toLocaleString();
    switch (blocker.kind) {
        case 'auth_invalid':
            return t('connectedServices.detail.groups.memberAuthInvalidUntil', { time });
        case 'plan_unavailable':
            return t('connectedServices.detail.groups.memberPlanUnavailableUntil', { time });
        case 'validation_blocked':
            return t('connectedServices.detail.groups.memberValidationBlockedUntil', { time });
        case 'quota_exhausted':
            return t('connectedServices.detail.groups.memberQuotaExhaustedUntil', { time });
        case 'rate_limited':
            return t('connectedServices.detail.groups.memberRateLimitedUntil', { time });
        case 'capacity_limited':
            return t('connectedServices.detail.groups.memberCapacityLimitedUntil', { time });
        case 'exhausted':
            return t('connectedServices.detail.groups.memberExhaustedUntil', { time });
        case 'cooldown':
            return t('connectedServices.detail.groups.cooldown', { time });
    }
}

export function resolveConnectedServiceGroupProfileTitle(params: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    labelsByKey: Readonly<Record<string, string | undefined>>;
    profiles?: ReadonlyArray<ConnectedServiceGroupProfileLike>;
}>): string {
    return resolveConnectedServiceGroupMemberIdentity({
        labelsByKey: params.labelsByKey,
        serviceId: params.serviceId,
        profileId: params.profileId,
        profiles: params.profiles,
    }).label;
}

export function resolveConnectedServiceGroupMissingEligibleWarning(group: ConnectedServiceGroupViewModel): string | null {
    const enabledMembers = group.members.filter((member) => member.enabled);
    if (enabledMembers.length === 0) return t('connectedServices.detail.groups.warningNoEnabledMembers');
    if (!group.policy.autoSwitch) return null;
    if (enabledMembers.length === 1) return t('connectedServices.detail.groups.warningNoFallbackMember');
    return null;
}

export function resolveConnectedServiceGroupSoftSwitchRemainingPercent(group: ConnectedServiceAuthGroupV1): number {
    const value = group.policy.softSwitchRemainingPercent;
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : CONNECTED_SERVICE_GROUP_DEFAULT_POLICY.softSwitchRemainingPercent;
}

export function resolveConnectedServiceGroupProbeIfSnapshotOlderThanMs(group: ConnectedServiceAuthGroupV1): number {
    const value = group.policy.probeIfSnapshotOlderThanMs;
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : CONNECTED_SERVICE_GROUP_DEFAULT_POLICY.probeIfSnapshotOlderThanMs;
}

export function resolveConnectedServiceGroupSwitchBudget(group: ConnectedServiceAuthGroupV1): Readonly<{
    perTurn: number;
    perSessionHour: number;
}> {
    const perTurn = group.policy.maxSwitchesPerTurn;
    const perSessionHour = group.policy.maxSwitchesPerSessionHour;
    return {
        perTurn: typeof perTurn === 'number' && Number.isFinite(perTurn)
            ? perTurn
            : CONNECTED_SERVICE_GROUP_DEFAULT_POLICY.maxSwitchesPerTurn,
        perSessionHour: typeof perSessionHour === 'number' && Number.isFinite(perSessionHour)
            ? perSessionHour
            : CONNECTED_SERVICE_GROUP_DEFAULT_POLICY.maxSwitchesPerSessionHour,
    };
}

export function resolveConnectedServiceGroupRecoveryMode(
    group: ConnectedServiceAuthGroupV1,
): ConnectedServiceAuthGroupPolicyV1['recoveryMode'] {
    const value = group.policy.recoveryMode;
    return value === 'off' || value === 'wait_until_reset' || value === 'switch_then_resume' || value === 'switch_or_wait'
        ? value
        : CONNECTED_SERVICE_GROUP_DEFAULT_POLICY.recoveryMode;
}
