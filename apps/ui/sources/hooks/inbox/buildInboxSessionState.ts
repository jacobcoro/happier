import type { Session } from '@/sync/domains/state/storageTypes';
import {
    deriveActivityAttentionFlags,
    resolveActivityAttentionSessions,
    resolveActivityAttentionSessionsFromRecords,
} from '@/activity/attention/activityAttentionSessions';
import { listPendingPermissionRequests, listPendingUserActionRequests, type PendingPermissionRequest } from '@/utils/sessions/sessionUtils';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import { deriveSessionRuntimePresentationState } from '@/sync/domains/session/attention/deriveSessionRuntimePresentationState';
import { readStoredSessionMessagesFromStateLike } from '@/sync/domains/messages/readStoredSessionMessages';
import { forEachRecordValue } from '@/sync/store/sessionRecordProjection';
import type { StorageState } from '@/sync/store/types';

export type InboxSessionAttentionEntry = Readonly<{
    session: Session;
    pendingPermissions: readonly PendingPermissionRequest[];
    pendingUserActions: readonly PendingPermissionRequest[];
}>;

export type InboxUnreadSession = Session | SessionListRenderableSession;

export type InboxSessionState = Readonly<{
    unreadSessions: InboxUnreadSession[];
    sessionsNeedingAttention: InboxSessionAttentionEntry[];
}>;

type BuildInboxSessionStateInput =
    | readonly Session[]
    | Readonly<{
        sessions: readonly Session[];
        sessionRows?: readonly InboxUnreadSession[];
        sessionMessagesById?: StorageState['sessionMessages'];
        nowMs?: number;
    }>;

export type InboxSessionContentRecordInput = Readonly<{
    sessionsById: Readonly<Record<string, Session>>;
    sessionRowsById?: Readonly<Record<string, InboxUnreadSession>>;
    sessionMessagesById?: StorageState['sessionMessages'];
    nowMs?: number;
}>;

function normalizeBuildInboxSessionStateInput(input: BuildInboxSessionStateInput): Readonly<{
    sessions: readonly Session[];
    sessionRows: readonly InboxUnreadSession[];
    sessionMessagesById?: StorageState['sessionMessages'];
    nowMs: number;
}> {
    if ('sessions' in input) {
        return {
            sessions: input.sessions,
            sessionRows: input.sessionRows && input.sessionRows.length > 0 ? input.sessionRows : input.sessions,
            sessionMessagesById: input.sessionMessagesById,
            nowMs: typeof input.nowMs === 'number' && Number.isFinite(input.nowMs) ? input.nowMs : Date.now(),
        };
    }
    return { sessions: input, sessionRows: input, nowMs: Date.now() };
}

function readMessagesForInboxSession(
    sessionMessagesById: StorageState['sessionMessages'] | undefined,
    sessionId: string,
) {
    if (!sessionMessagesById) return undefined;
    return readStoredSessionMessagesFromStateLike(sessionMessagesById[sessionId]);
}

function hasUnreadSessionAttention(
    session: InboxUnreadSession,
    sessionMessagesById?: StorageState['sessionMessages'],
): boolean {
    return deriveActivityAttentionFlags(session, {
        showPendingPermissionRequests: false,
        showPendingUserActionRequests: false,
        showQueuedUserInput: false,
        sessionMessagesById,
    }).hasUnread;
}

function hasFreshPendingInboxAttention(params: Readonly<{
    session: Session;
    pendingPermissions: readonly PendingPermissionRequest[];
    pendingUserActions: readonly PendingPermissionRequest[];
    nowMs: number;
}>): boolean {
    if (params.pendingPermissions.length === 0 && params.pendingUserActions.length === 0) return false;
    const runtimeStatus = deriveSessionRuntimePresentationState({
        active: params.session.active,
        activeAt: params.session.activeAt,
        presence: params.session.presence,
        thinking: params.session.thinking,
        thinkingAt: params.session.thinkingAt,
        latestTurnStatus: params.session.latestTurnStatus,
        latestTurnStatusObservedAt: params.session.latestTurnStatusObservedAt,
        meaningfulActivityAt: params.session.meaningfulActivityAt,
        hasPendingPermissionRequests: params.pendingPermissions.length > 0,
        hasPendingUserActionRequests: params.pendingUserActions.length > 0,
        pendingRequestObservedAt: latestPendingRequestObservedAt([
            ...params.pendingPermissions,
            ...params.pendingUserActions,
        ]),
    }, params.nowMs);
    return runtimeStatus.freshPermissionRequired || runtimeStatus.freshActionRequired;
}

function latestPendingRequestObservedAt(requests: readonly PendingPermissionRequest[]): number | null {
    let latest: number | null = null;
    for (const request of requests) {
        const createdAt = request.createdAt;
        if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt <= 0) continue;
        latest = latest === null ? createdAt : Math.max(latest, createdAt);
    }
    return latest;
}

export function buildInboxSessionState(input: BuildInboxSessionStateInput): InboxSessionState {
    const { sessions, sessionRows, sessionMessagesById, nowMs } = normalizeBuildInboxSessionStateInput(input);
    const sessionsNeedingAttention: InboxSessionAttentionEntry[] = [];
    const attentionSessionIds = new Set<string>();

    for (const session of sessions) {
        if (session.archivedAt != null) continue;
        if (!isUserFacingSession(session)) continue;
        const messages = readMessagesForInboxSession(sessionMessagesById, session.id);
        const pendingPermissions = listPendingPermissionRequests(session, messages);
        const pendingUserActions = listPendingUserActionRequests(session, messages);
        if (!hasFreshPendingInboxAttention({
            session,
            pendingPermissions,
            pendingUserActions,
            nowMs,
        })) continue;

        attentionSessionIds.add(session.id);
        sessionsNeedingAttention.push({
            session,
            pendingPermissions,
            pendingUserActions,
        });
    }

    const unreadCandidates = resolveActivityAttentionSessions({ sessions, sessionRows });

    const unreadSessions: InboxUnreadSession[] = [];
    const unreadSessionIds = new Set<string>();
    for (const session of unreadCandidates) {
        if (!isUserFacingSession(session)) continue;
        if (attentionSessionIds.has(session.id)) continue;
        if (unreadSessionIds.has(session.id)) continue;
        if (!hasUnreadSessionAttention(session, sessionMessagesById)) continue;
        unreadSessionIds.add(session.id);
        unreadSessions.push(session);
    }

    return {
        unreadSessions,
        sessionsNeedingAttention,
    };
}

export function hasInboxSessionContent(input: BuildInboxSessionStateInput): boolean {
    const { sessions, sessionRows, sessionMessagesById, nowMs } = normalizeBuildInboxSessionStateInput(input);
    const attentionSessionIds = new Set<string>();

    for (const session of sessions) {
        if (session.archivedAt != null) continue;
        if (!isUserFacingSession(session)) continue;
        const messages = readMessagesForInboxSession(sessionMessagesById, session.id);
        const pendingPermissions = listPendingPermissionRequests(session, messages);
        const pendingUserActions = listPendingUserActionRequests(session, messages);
        if (!hasFreshPendingInboxAttention({
            session,
            pendingPermissions,
            pendingUserActions,
            nowMs,
        })) continue;
        attentionSessionIds.add(session.id);
        return true;
    }

    const unreadCandidates = resolveActivityAttentionSessions({ sessions, sessionRows });
    const unreadSessionIds = new Set<string>();
    for (const session of unreadCandidates) {
        if (!isUserFacingSession(session)) continue;
        if (attentionSessionIds.has(session.id)) continue;
        if (unreadSessionIds.has(session.id)) continue;
        if (!hasUnreadSessionAttention(session, sessionMessagesById)) continue;
        unreadSessionIds.add(session.id);
        return true;
    }

    return false;
}

export function hasInboxSessionContentForRecords(input: InboxSessionContentRecordInput): boolean {
    const nowMs = typeof input.nowMs === 'number' && Number.isFinite(input.nowMs)
        ? input.nowMs
        : Date.now();
    const attentionSessionIds = new Set<string>();

    forEachRecordValue(input.sessionsById, (session) => {
        if (session.archivedAt != null) return;
        if (!isUserFacingSession(session)) return;
        const messages = readMessagesForInboxSession(input.sessionMessagesById, session.id);
        const pendingPermissions = listPendingPermissionRequests(session, messages);
        const pendingUserActions = listPendingUserActionRequests(session, messages);
        if (!hasFreshPendingInboxAttention({
            session,
            pendingPermissions,
            pendingUserActions,
            nowMs,
        })) return;
        attentionSessionIds.add(session.id);
    });
    if (attentionSessionIds.size > 0) return true;

    const unreadCandidates = resolveActivityAttentionSessionsFromRecords({
        sessionsById: input.sessionsById,
        sessionRowsById: input.sessionRowsById,
    });
    const unreadSessionIds = new Set<string>();
    for (const session of unreadCandidates) {
        if (!isUserFacingSession(session)) continue;
        if (attentionSessionIds.has(session.id)) continue;
        if (unreadSessionIds.has(session.id)) continue;
        if (!hasUnreadSessionAttention(session, input.sessionMessagesById)) continue;
        unreadSessionIds.add(session.id);
        return true;
    }

    return false;
}
