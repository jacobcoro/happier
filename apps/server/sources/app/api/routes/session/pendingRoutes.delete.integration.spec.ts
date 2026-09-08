import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock } from "../../testkit/dbMocks";
import { createRouteTestBuilder } from "../../testkit/routeTestBuilder";

const deletePendingMessage = vi.fn();
const discardPendingMessage = vi.fn();
const dbMocks = createDbMocks({ session: ["findUnique"] } as const);

installDbModuleMock({ db: dbMocks.db });

vi.mock("@/app/session/pending/pendingMessageService", () => ({
    deletePendingMessage,
    discardPendingMessage,
}));

describe("sessionPendingRoutes (delete) (status mapping)", () => {
    beforeEach(() => {
        vi.resetModules();
        dbMocks.reset();
        dbMocks.db.session.findUnique.mockResolvedValue(null);
        deletePendingMessage.mockReset();
        discardPendingMessage.mockReset();
    });

    it("returns success when pending localId is already absent", async () => {
        deletePendingMessage.mockResolvedValueOnce({
            ok: true,
            pendingCount: 3,
            pendingVersion: 7,
            participantCursors: [],
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "DELETE",
            path: "/v2/sessions/:sessionId/pending/:localId",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { reply } = await route.invoke({ userId: "actor", params: { sessionId: "s1", localId: "l1" } });

        expect(reply.code).not.toHaveBeenCalled();
        expect(reply.send).toHaveBeenCalledWith({ ok: true, pendingCount: 3, pendingVersion: 7 });
    });

    it("maps a delivering-row settlement conflict to 409", async () => {
        deletePendingMessage.mockResolvedValueOnce({
            ok: false,
            error: "delivery-settlement-conflict",
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "DELETE",
            path: "/v2/sessions/:sessionId/pending/:localId",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { reply, response } = await route.invoke({
            id: "req-delete-conflict",
            userId: "actor",
            params: { sessionId: "s1", localId: "l1" },
        });

        expect(deletePendingMessage).toHaveBeenCalledWith({
            actorUserId: "actor",
            sessionId: "s1",
            localId: "l1",
            diagnosticCorrelationId: "req-delete-conflict",
        });
        expect(reply.statusCode).toBe(409);
        expect(response).toEqual({ error: "delivery-settlement-conflict" });
    });

    it("maps a transaction acquisition failure to retryable 503", async () => {
        deletePendingMessage.mockResolvedValueOnce({
            ok: false,
            error: "transaction-unavailable",
            retryAfterMs: 1_000,
            correlationId: "req-delete-busy",
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "DELETE",
            path: "/v2/sessions/:sessionId/pending/:localId",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { reply, response } = await route.invoke({
            id: "req-delete-busy",
            userId: "actor",
            params: { sessionId: "s1", localId: "l1" },
        });

        expect(reply.statusCode).toBe(503);
        expect(reply.headers.get("retry-after")).toBe("1");
        expect(response).toEqual({
            error: "transaction-unavailable",
            retryAfterMs: 1_000,
            correlationId: "req-delete-busy",
        });
    });

    it("maps a claimed-row discard conflict to 409", async () => {
        discardPendingMessage.mockResolvedValueOnce({
            ok: false,
            error: "delivery-settlement-conflict",
        });

        const { sessionPendingRoutes } = await import("./pendingRoutes");
        const route = createRouteTestBuilder({
            method: "POST",
            path: "/v2/sessions/:sessionId/pending/:localId/discard",
            registerRoutes(app) {
                sessionPendingRoutes(app as any);
            },
        });
        const { reply, response } = await route.invoke({
            userId: "actor",
            params: { sessionId: "s1", localId: "l1" },
            body: { reason: "user_discarded" },
        });

        expect(discardPendingMessage).toHaveBeenCalledWith({
            actorUserId: "actor",
            sessionId: "s1",
            localId: "l1",
            reason: "user_discarded",
        });
        expect(reply.statusCode).toBe(409);
        expect(response).toEqual({ error: "delivery-settlement-conflict" });
    });
});
