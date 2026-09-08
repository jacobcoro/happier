import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock } from "../../testkit/dbMocks";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";
import { createFakeRouteApp } from "../../testkit/routeHarness";

const emitUpdate = vi.fn();
const buildNewMessageUpdate = vi.fn(() => ({ type: "new-message" }));
const buildMessageUpdatedUpdate = vi.fn(() => ({ type: "message-updated" }));
const buildPendingChangedUpdate = vi.fn(() => ({ type: "pending-changed" }));
const buildUpdateSessionUpdate = vi.fn(() => ({ type: "update-session" }));
const getSessionParticipantUserIds = vi.fn(async () => ["u1"]);
const markAccountChanged = vi.fn(async () => 10);
const refreshSessionParticipantBadgePushes = vi.fn(async () => {});

const materializeNextPendingMessage = vi.fn();
const listPendingMessages = vi.fn();
const resolveAcceptedPendingDelivery = vi.fn();
const blockPendingDelivery = vi.fn();
const markPendingDeliveryHandled = vi.fn();
const dismissPendingDelivery = vi.fn();
const sendPendingDeliveryAsNew = vi.fn();
const updatePendingMessage = vi.fn();
const dbMocks = createDbMocks({ session: ["findUnique"] } as const);

installDbModuleMock({ db: dbMocks.db });

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate },
    buildNewMessageUpdate,
    buildMessageUpdatedUpdate,
    buildPendingChangedUpdate,
    buildUpdateSessionUpdate,
}));

vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked: () => "k" }));
vi.mock("@/app/share/sessionParticipants", () => ({ getSessionParticipantUserIds }));
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));
vi.mock("@/app/activity/refreshAccountActivityBadgePushes", () => ({ refreshSessionParticipantBadgePushes }));
vi.mock("@/storage/inTx", () => ({
    inTx: vi.fn(async (fn: (tx: unknown) => unknown) => await fn({})),
}));

vi.mock("@/app/session/pending/pendingMessageService", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/session/pending/pendingMessageService")>();
    return {
        ...actual,
        listPendingMessages,
        materializeNextPendingMessage,
        resolveAcceptedPendingDelivery,
        blockPendingDelivery,
        markPendingDeliveryHandled,
        dismissPendingDelivery,
        sendPendingDeliveryAsNew,
        updatePendingMessage,
    };
});

describe("sessionPendingRoutes (materialize-next)", () => {
    beforeEach(() => {
        vi.resetModules();
        dbMocks.reset();
        dbMocks.db.session.findUnique.mockResolvedValue(null);
        emitUpdate.mockReset();
        buildNewMessageUpdate.mockClear();
        buildMessageUpdatedUpdate.mockClear();
        buildPendingChangedUpdate.mockClear();
        buildUpdateSessionUpdate.mockClear();
        getSessionParticipantUserIds.mockReset();
        getSessionParticipantUserIds.mockResolvedValue(["u1"]);
        markAccountChanged.mockReset();
        markAccountChanged.mockResolvedValue(10);
        refreshSessionParticipantBadgePushes.mockReset();
        refreshSessionParticipantBadgePushes.mockResolvedValue(undefined);
        materializeNextPendingMessage.mockReset();
        listPendingMessages.mockReset();
        resolveAcceptedPendingDelivery.mockReset();
        blockPendingDelivery.mockReset();
        markPendingDeliveryHandled.mockReset();
        dismissPendingDelivery.mockReset();
        sendPendingDeliveryAsNew.mockReset();
        updatePendingMessage.mockReset();
    });

    it("projects typed deliveryStatus in pending GET responses while retaining raw delivery fields", async () => {
        const createdAt = new Date(1_000);
        const updatedAt = new Date(2_000);
        listPendingMessages.mockResolvedValueOnce({
            ok: true,
            pending: [
                {
                    localId: "l-blocked",
                    messageRole: "user",
                    content: { t: "plain", v: { role: "user", content: { type: "text", text: "hello" } } },
                    status: "queued",
                    deliveryState: "blocked",
                    deliveryBlockedReason: "terminal_composer_draft",
                    deliveryStatus: { status: "blocked", reason: "terminal_composer_draft" },
                    position: 1,
                    createdAt,
                    updatedAt,
                    discardedAt: null,
                    discardedReason: null,
                    authorAccountId: "actor",
                },
            ],
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "GET",
            path: "/v2/sessions/:sessionId/pending",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { response: res } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1" },
        });

        expect(listPendingMessages).toHaveBeenCalledWith({
            actorUserId: "actor",
            sessionId: "s1",
            includeDiscarded: false,
        });
        expect(res).toEqual({
            pending: [
                expect.objectContaining({
                    localId: "l-blocked",
                    status: "queued",
                    deliveryState: "blocked",
                    deliveryBlockedReason: "terminal_composer_draft",
                    deliveryStatus: { status: "blocked", reason: "terminal_composer_draft" },
                }),
            ],
        });
    });

    it("fails omitted HTTP materialization closed without invoking the Pending owner", async () => {
        materializeNextPendingMessage.mockResolvedValueOnce({
            ok: true,
            didMaterialize: false,
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 1,
        });
        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/materialize-next",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { reply, response: res } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1" },
        });

        expect(reply.statusCode).toBe(403);
        expect(res).toEqual({ error: "forbidden" });
        expect(materializeNextPendingMessage).not.toHaveBeenCalled();
        expect(buildNewMessageUpdate).not.toHaveBeenCalled();
        expect(buildPendingChangedUpdate).not.toHaveBeenCalled();
    });

    it("fails HTTP provider materialization closed without invoking the Pending owner", async () => {
        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/materialize-next",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { reply, response: res } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1" },
            body: { deliveryState: "provider" },
        });

        expect(reply.statusCode).toBe(403);
        expect(res).toEqual({ error: "forbidden" });
        expect(materializeNextPendingMessage).not.toHaveBeenCalled();
    });

    it("maps stale pending update races to a client-safe not-found response", async () => {
        updatePendingMessage.mockResolvedValueOnce({ ok: false, error: "not-found" });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "PATCH",
            path: "/v2/sessions/:sessionId/pending/:localId",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { reply, response: res } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1", localId: "missing-local" },
            body: { ciphertext: "cipher-updated" },
        });

        expect(reply.statusCode).toBe(404);
        expect(res).toEqual({ error: "not-found" });
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("rejects HTTP provider delivery-state opt-in while retaining the legacy route", async () => {
        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/materialize-next",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { reply, response: res } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1" },
            body: { deliveryState: "provider" },
        });

        expect(reply.statusCode).toBe(403);
        expect(res).toEqual({ error: "forbidden" });
        expect(materializeNextPendingMessage).not.toHaveBeenCalled();
        expect(buildNewMessageUpdate).not.toHaveBeenCalled();
    });

    it("does not expose user-authenticated HTTP provider-settlement authority", async () => {
        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const app = createFakeRouteApp();
        sessionPendingRoutes(app as any);

        expect(app.routes.has("POST /v2/sessions/:sessionId/pending/:localId/delivery/accepted")).toBe(false);
        expect(resolveAcceptedPendingDelivery).not.toHaveBeenCalled();
        expect(emitUpdate).not.toHaveBeenCalled();
    });
    it("blocks an exact provider-unavailable delivery before acceptance", async () => {
        blockPendingDelivery.mockResolvedValueOnce({
            ok: true,
            pendingCount: 1,
            pendingBlockedCount: 1,
            pendingVersion: 4,
            participantCursors: [
                { accountId: "u1", cursor: 40 },
                { accountId: "u2", cursor: 41 },
            ],
            badgeAttentionChanged: false,
            didUpdate: true,
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/:localId/delivery/block",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { response: res } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1", localId: "l-provider" },
            body: { reason: "provider_unavailable_before_acceptance" },
        });

        expect(blockPendingDelivery).toHaveBeenCalledWith({
            actorUserId: "actor",
            sessionId: "s1",
            localId: "l-provider",
            reason: "provider_unavailable_before_acceptance",
        });
        expect(res).toEqual({
            ok: true,
            pendingCount: 1,
            pendingBlockedCount: 1,
            pendingVersion: 4,
        });
        expect(buildPendingChangedUpdate).toHaveBeenCalledTimes(2);
        expect(emitUpdate).toHaveBeenCalledTimes(2);
    });

    it("marks a provider delivery handled by explicit user resolution", async () => {
        markPendingDeliveryHandled.mockResolvedValueOnce({
            ok: true,
            pendingCount: 0,
            pendingVersion: 6,
            participantCursors: [
                { accountId: "u1", cursor: 60 },
                { accountId: "u2", cursor: 61 },
            ],
            participantCursorsPending: [
                { accountId: "u1", cursor: 60 },
                { accountId: "u2", cursor: 61 },
            ],
            badgeAttentionChanged: true,
            didResolve: true,
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/:localId/delivery/handled",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { response: res } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1", localId: "l-provider" },
        });

        expect(markPendingDeliveryHandled).toHaveBeenCalledWith({
            actorUserId: "actor",
            sessionId: "s1",
            localId: "l-provider",
        });
        expect(res).toEqual({
            ok: true,
            pendingCount: 0,
            pendingVersion: 6,
        });
        expect(buildNewMessageUpdate).not.toHaveBeenCalled();
        expect(buildPendingChangedUpdate).toHaveBeenCalledTimes(2);
        expect(emitUpdate).toHaveBeenCalledTimes(2);
    });

    it("routes explicit uncertain dismissal without creating a message", async () => {
        dismissPendingDelivery.mockResolvedValueOnce({
            ok: true,
            didDismiss: true,
            pendingCount: 0,
            pendingBlockedCount: 0,
            pendingVersion: 7,
            participantCursors: [{ accountId: "u1", cursor: 70 }],
            badgeAttentionChanged: true,
        });
        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/:localId/delivery/dismiss",
            registerRoutes(app) { sessionPendingRoutes(app as any); },
        });
        const { response } = await route.invoke({ userId: "actor", params: { sessionId: "s1", localId: "l-provider" } });
        expect(dismissPendingDelivery).toHaveBeenCalledWith({ actorUserId: "actor", sessionId: "s1", localId: "l-provider" });
        expect(response).toMatchObject({ ok: true, didDismiss: true, pendingCount: 0, pendingVersion: 7 });
        expect(buildNewMessageUpdate).not.toHaveBeenCalled();
    });

    it("leaves deterministic send-as-new identity with the atomic service owner", async () => {
        sendPendingDeliveryAsNew.mockResolvedValueOnce({
            ok: true,
            didWrite: true,
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 8,
            participantCursors: [{ accountId: "u1", cursor: 80 }],
            badgeAttentionChanged: false,
        });
        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/:localId/delivery/send-as-new",
            registerRoutes(app) { sessionPendingRoutes(app as any); },
        });
        const { response } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1", localId: "l-provider" },
            body: {},
        });
        expect(sendPendingDeliveryAsNew).toHaveBeenCalledWith({
            actorUserId: "actor",
            sessionId: "s1",
            localId: "l-provider",
        });
        expect(response).toMatchObject({ ok: true, didWrite: true, pendingCount: 1, pendingVersion: 8 });
    });

    it("emits pending-changed when handled provider delivery blocks on transcript conflict", async () => {
        markPendingDeliveryHandled.mockResolvedValueOnce({
            ok: false,
            error: "transcript-conflict",
            pendingStateChanged: true,
            pendingCount: 1,
            pendingBlockedCount: 1,
            pendingVersion: 9,
            participantCursors: [{ accountId: "u1", cursor: 63 }],
            badgeAttentionChanged: true,
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/:localId/delivery/handled",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { reply, response: res } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1", localId: "l-provider-conflict" },
        });

        expect(reply.statusCode).toBe(409);
        expect(res).toEqual({ error: "transcript-conflict" });
        expect(buildPendingChangedUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: "s1",
                pendingCount: 1,
                pendingBlockedCount: 1,
                pendingVersion: 9,
            }),
            63,
            "k",
        );
        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(refreshSessionParticipantBadgePushes).toHaveBeenCalledWith({
            badgeAttentionChanged: true,
            participantCursors: [{ accountId: "u1", cursor: 63 }],
        });
    });

});
