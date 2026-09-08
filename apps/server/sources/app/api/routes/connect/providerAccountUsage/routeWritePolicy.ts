import type {
    ProviderAccountUsageRecordId,
    ProviderAccountUsageRecordKeyV1,
    ProviderAccountUsageSnapshotV1,
    SealedProviderAccountUsageSnapshotV1,
} from "@happier-dev/protocol";
import { mergeProviderAccountSubscription } from "@happier-dev/protocol";
import { isPrismaErrorCode, type TransactionClient } from "@/storage/prisma";

import { inTx } from "@/storage/inTx";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import {
    createProviderAccountUsageRecord,
    readProviderAccountUsageRecord,
    updateProviderAccountUsageRecordIfCurrent,
} from "./recordStorage";
import type { ProviderAccountUsagePayloadMode, ProviderAccountUsageStatus } from "./types";
import { ProviderAccountUsagePayloadInvariantError } from "./types";

type ProviderAccountUsagePolicyClient = Pick<typeof import("@/storage/db").db, "account" | "providerAccountUsageRecord">
    | Pick<TransactionClient, "account" | "providerAccountUsageRecord">;

export type ProviderAccountUsageWritePolicyParams = Readonly<{
    accountId: string;
    recordId: ProviderAccountUsageRecordId;
    recordKey: ProviderAccountUsageRecordKeyV1;
    payloadMode: ProviderAccountUsagePayloadMode;
    status: Exclude<ProviderAccountUsageStatus, "refresh_requested">;
    fetchedAt: number;
    staleAfterMs: number;
    materialFingerprint?: string;
    snapshot?: ProviderAccountUsageSnapshotV1;
    sealedPayload?: SealedProviderAccountUsageSnapshotV1;
    client?: ProviderAccountUsagePolicyClient;
}>;

type ProviderAccountUsageWritePolicyOverrides = Partial<Omit<ProviderAccountUsageWritePolicyParams, "client">> & Readonly<{
    refreshRequestedAt?: number;
}>;

function normalizeFingerprint(value: string | undefined): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function shouldClearRefreshRequest(refreshRequestedAt: number | undefined, fetchedAt: number): boolean {
    return refreshRequestedAt !== undefined && fetchedAt >= refreshRequestedAt;
}

function shouldPreserveRefreshRequest(refreshRequestedAt: number | undefined, fetchedAt: number): boolean {
    return refreshRequestedAt !== undefined && fetchedAt < refreshRequestedAt;
}

function isUniqueConstraintError(error: unknown): boolean {
    return isPrismaErrorCode(error, "P2002");
}

function buildWriteParams(
    params: ProviderAccountUsageWritePolicyParams,
    overrides: ProviderAccountUsageWritePolicyOverrides = {},
) {
    const merged = { ...params, ...overrides };
    return {
        accountId: merged.accountId,
        recordId: merged.recordId,
        recordKey: merged.recordKey,
        payloadMode: merged.payloadMode,
        status: merged.status,
        fetchedAt: merged.fetchedAt,
        staleAfterMs: merged.staleAfterMs,
        ...(merged.snapshot ? { snapshot: merged.snapshot } : {}),
        ...(merged.sealedPayload ? { sealedPayload: merged.sealedPayload } : {}),
        ...(merged.materialFingerprint ? { metadata: { materialFingerprint: merged.materialFingerprint } } : {}),
        ...(merged.refreshRequestedAt !== undefined ? { refreshRequestedAt: merged.refreshRequestedAt } : {}),
    };
}

async function writeProviderAccountUsageRecordWithPolicyInClient(
    params: ProviderAccountUsageWritePolicyParams & Readonly<{ client: ProviderAccountUsagePolicyClient }>,
): Promise<"written" | "noop" | "stale"> {
    const account = await params.client.account.findUnique({
        where: { id: params.accountId },
        select: { publicKey: true, encryptionMode: true },
    });
    const expectedMode = params.payloadMode === "plain_json_v1" ? "plain" : "e2ee";
    if (!account || resolveEffectiveAccountEncryptionModeFromAccountRow(account) !== expectedMode) {
        throw new ProviderAccountUsagePayloadInvariantError("Provider account usage payload mode does not match account storage mode");
    }
    const incomingFingerprint = normalizeFingerprint(params.materialFingerprint);
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const existing = await readProviderAccountUsageRecord({
            accountId: params.accountId,
            recordId: params.recordId,
        }, params.client);

        if (!existing) {
            try {
                await createProviderAccountUsageRecord(buildWriteParams(
                    params,
                    incomingFingerprint ? { materialFingerprint: incomingFingerprint } : {},
                ), params.client);
                return "written";
            } catch (error) {
                if (isUniqueConstraintError(error)) continue;
                throw error;
            }
        }

        const existingFingerprint = normalizeFingerprint(existing.metadata?.materialFingerprint);
        const existingFetchedAt = existing.fetchedAt ?? null;
        const isNewer = existingFetchedAt === null || params.fetchedAt > existingFetchedAt;
        const clearsRefreshRequest = shouldClearRefreshRequest(existing.refreshRequestedAt, params.fetchedAt);
        const preservesRefreshRequest = shouldPreserveRefreshRequest(existing.refreshRequestedAt, params.fetchedAt);

        const previousSubscription = existing.sealedPayload?.subscription;
        const incomingSubscription = params.sealedPayload?.subscription;
        const sealedSubscription = incomingSubscription && (!previousSubscription || incomingSubscription.observedAtMs > previousSubscription.observedAtMs)
            ? incomingSubscription
            : previousSubscription;
        const plainSubscription = mergeProviderAccountSubscription(existing.snapshot?.subscription, params.snapshot?.subscription);
        const subscriptionAdvanced = sealedSubscription !== previousSubscription
            || JSON.stringify(plainSubscription) !== JSON.stringify(existing.snapshot?.subscription);

        let nextWrite;
        let result: "written" | "noop" | "stale";
        if (!incomingFingerprint) {
            if (!isNewer && !subscriptionAdvanced) return "stale";
            nextWrite = buildWriteParams(params, {
                ...(preservesRefreshRequest ? { refreshRequestedAt: existing.refreshRequestedAt } : {}),
            });
            result = "written";
        } else if (existingFingerprint === incomingFingerprint) {
            if (!isNewer && !clearsRefreshRequest && !subscriptionAdvanced) return "noop";
            const preservedStatus = existing.status === "refresh_requested" ? params.status : existing.status;
            nextWrite = buildWriteParams(params, {
                status: isNewer ? params.status : preservedStatus,
                fetchedAt: isNewer ? params.fetchedAt : (existing.fetchedAt ?? params.fetchedAt),
                staleAfterMs: isNewer ? params.staleAfterMs : (existing.staleAfterMs ?? params.staleAfterMs),
                snapshot: params.payloadMode === "plain_json_v1"
                    ? (isNewer ? params.snapshot : existing.snapshot)
                    : undefined,
                sealedPayload: params.payloadMode === "sealed_account_scoped_v1"
                    ? (isNewer ? params.sealedPayload : existing.sealedPayload)
                    : undefined,
                materialFingerprint: incomingFingerprint,
                ...(preservesRefreshRequest ? { refreshRequestedAt: existing.refreshRequestedAt } : {}),
            });
            result = "written";
        } else {
            if (!isNewer && !subscriptionAdvanced) return "stale";
            nextWrite = buildWriteParams(params, {
                materialFingerprint: incomingFingerprint,
                ...(preservesRefreshRequest ? { refreshRequestedAt: existing.refreshRequestedAt } : {}),
            });
            result = "written";
        }

        if (params.payloadMode === "sealed_account_scoped_v1" && sealedSubscription) {
            const basePayload = isNewer ? params.sealedPayload : existing.sealedPayload;
            nextWrite = {
                ...nextWrite,
                ...(!isNewer ? {
                    fetchedAt: existing.fetchedAt ?? params.fetchedAt,
                    staleAfterMs: existing.staleAfterMs ?? params.staleAfterMs,
                    status: existing.status === "refresh_requested" ? params.status : existing.status,
                } : {}),
                sealedPayload: basePayload ? { ...basePayload, subscription: sealedSubscription } : undefined,
            };
        }
        if (params.payloadMode === "plain_json_v1" && plainSubscription) {
            const baseSnapshot = isNewer ? params.snapshot : existing.snapshot;
            nextWrite = {
                ...nextWrite,
                ...(!isNewer ? {
                    fetchedAt: existing.fetchedAt ?? params.fetchedAt,
                    staleAfterMs: existing.staleAfterMs ?? params.staleAfterMs,
                    status: existing.status === "refresh_requested" ? params.status : existing.status,
                } : {}),
                snapshot: baseSnapshot ? { ...baseSnapshot, subscription: plainSubscription } : undefined,
            };
        }

        const updated = await updateProviderAccountUsageRecordIfCurrent(nextWrite, {
            fetchedAt: existing.fetchedAt,
            ...(existing.refreshRequestedAt !== undefined ? { refreshRequestedAt: existing.refreshRequestedAt } : {}),
        }, params.client);
        if (updated) return result;
    }

    throw new Error("Provider account usage write policy could not commit after concurrent changes");
}

export async function writeProviderAccountUsageRecordWithPolicy(
    params: ProviderAccountUsageWritePolicyParams,
): Promise<"written" | "noop" | "stale"> {
    if (params.client) {
        return await writeProviderAccountUsageRecordWithPolicyInClient({
            ...params,
            client: params.client,
        });
    }
    return await inTx(async (tx) => await writeProviderAccountUsageRecordWithPolicyInClient({
        ...params,
        client: tx,
    }));
}
