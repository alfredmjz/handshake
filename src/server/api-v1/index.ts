// API v1 for Pholio (docs/api-v1.md, architecture §9.10): one function from a Web Request to a Response.
// Runtime imports are relative, so the Vercel function bundles without the @/ alias (ADR-001).

import { summarizeGroup } from "../../lib/ledger";
import { decodeCursor, encodeCursor, isUuid, type CursorScope } from "./cursor";
import { error, iso, json, preflight } from "./http";
import { ApiStoreError, type ApiStore, type GroupDetailRow, type GroupRowApi, type PaymentsQuery } from "./store";
import { bearerToken, hashToken } from "./token";
import type { Debt, Group, GroupDetail, GroupList, Me, PaymentPage } from "./types";

export type { ApiStore } from "./store";
export { ApiStoreError } from "./store";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

type Route =
	| { kind: "me" }
	| { kind: "groups" }
	| { kind: "group"; groupId: string }
	| { kind: "payments"; groupId: string | null };

const BASE = "/api/v1/";

function route(pathname: string): Route | null {
	if (!pathname.startsWith(BASE)) return null;
	const parts = pathname.slice(BASE.length).split("/");
	if (parts.length > 3 || parts.some((part) => part === "")) return null;
	const [first, groupId, third] = parts;
	if (first === "me" && parts.length === 1) return { kind: "me" };
	if (first === "payments" && parts.length === 1) return { kind: "payments", groupId: null };
	if (first !== "groups") return null;
	if (parts.length === 1) return { kind: "groups" };
	// A group id that isn't a UUID can't name a group.
	if (!isUuid(groupId)) return null;
	if (parts.length === 2) return { kind: "group", groupId: groupId.toLowerCase() };
	if (third === "payments") return { kind: "payments", groupId: groupId.toLowerCase() };
	return null;
}

type Payments = { query: PaymentsQuery; scope: CursorScope };

function paymentsQuery(url: URL, groupId: string | null): Payments | Response {
	const scope: CursorScope = groupId ?? "all";
	const rawLimit = url.searchParams.get("limit");
	let limit = DEFAULT_LIMIT;
	if (rawLimit !== null) {
		if (!/^\d{1,4}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > MAX_LIMIT) {
			return error("bad_request", `limit must be a whole number from 1 to ${MAX_LIMIT}.`);
		}
		limit = Number(rawLimit);
	}
	const rawCursor = url.searchParams.get("cursor");
	let cursor: Record<string, number> = {};
	if (rawCursor !== null) {
		const decoded = decodeCursor(rawCursor, scope);
		if (!decoded) return error("bad_request", "cursor isn't a cursor this endpoint issued.");
		cursor = decoded;
	}
	return { query: { groupId, cursor, limit }, scope };
}

function toGroup(row: GroupRowApi, balanceCents: number): Group {
	return {
		id: row.id,
		name: row.name,
		role: row.role,
		memberId: row.memberId,
		balanceCents,
		completedAt: row.completedAt === null ? null : iso(row.completedAt),
		updatedAt: iso(row.updatedAt),
	};
}

// The owner's balance and their own debts, worked out with the app's ledger from SQL's per-member and
// per-pair totals (one synthetic entry that counts).
function toGroupDetail(row: GroupDetailRow): GroupDetail {
	const summary = summarizeGroup(
		[
			{
				kind: "expense",
				deletedAt: null,
				paymentStatus: null,
				shares: row.members.map((member) => ({
					memberId: member.memberId,
					paidCents: member.paidCents,
					owedCents: member.owedCents,
					owedTo: member.owedTo,
				})),
			},
		],
		row.members.map((member) => ({ id: member.memberId, displayName: member.displayName, hasLogin: false }))
	);
	const names = new Map(row.members.map((member) => [member.memberId, member.displayName]));
	const debts: Debt[] = summary.debts
		.filter((debt) => debt.fromMemberId === row.memberId || debt.toMemberId === row.memberId)
		.map((debt) => {
			const youOwe = debt.fromMemberId === row.memberId;
			const other = youOwe ? debt.toMemberId : debt.fromMemberId;
			return {
				memberId: other,
				name: names.get(other)!,
				direction: youOwe ? "you_owe" : "owes_you",
				amountCents: debt.amountCents,
			} as Debt;
		})
		.sort(
			(a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || (a.memberId < b.memberId ? -1 : 1)
		);
	const balance = summary.people.find((person) => person.memberId === row.memberId)?.balanceCents ?? 0;
	return { ...toGroup(row, balance), debts };
}

async function answer(store: ApiStore, tokenHash: string, target: Route, payments: Payments | null): Promise<Response> {
	switch (target.kind) {
		case "me": {
			const row = await store.me(tokenHash);
			const body: Me = { userId: row.userId, displayName: row.displayName };
			return json(200, body);
		}
		case "groups": {
			const rows = await store.groups(tokenHash);
			const body: GroupList = { groups: rows.map((row) => toGroup(row, row.paidCents - row.owedCents)) };
			return json(200, body);
		}
		case "group":
			return json(200, toGroupDetail(await store.group(tokenHash, target.groupId)));
		case "payments": {
			const parsed = payments!;
			const page = await store.payments(tokenHash, parsed.query);
			const body: PaymentPage = {
				payments: page.payments.map((payment) => ({
					id: payment.id,
					groupId: payment.groupId,
					groupName: payment.groupName,
					direction: payment.direction,
					counterpartyMemberId: payment.counterpartyMemberId,
					counterpartyName: payment.counterpartyName,
					amountCents: payment.amountCents,
					entryDate: payment.entryDate,
					notes: payment.notes,
					confirmedAt: iso(payment.confirmedAt),
				})),
				nextCursor: encodeCursor(parsed.scope, page.cursor),
				hasMore: page.hasMore,
				removedGroupIds: page.removedGroupIds,
			};
			return json(200, body);
		}
	}
}

export function createApiV1(deps: { store: ApiStore }): (request: Request) => Promise<Response> {
	return async (request) => {
		try {
			if (request.method === "OPTIONS") return preflight();
			if (request.method !== "GET") return error("method_not_allowed", undefined, { Allow: "GET, OPTIONS" });
			const url = new URL(request.url);
			const target = route(url.pathname);
			if (!target) return error("not_found");
			const token = bearerToken(request);
			if (!token) return error("invalid_token", undefined, { "WWW-Authenticate": "Bearer" });
			// Bad params are answered before the store is asked, so they never count against the rate limit.
			const payments = target.kind === "payments" ? paymentsQuery(url, target.groupId) : null;
			if (payments instanceof Response) return payments;
			return await answer(deps.store, await hashToken(token), target, payments);
		} catch (failure) {
			if (failure instanceof ApiStoreError) {
				if (failure.code === "HS401") return error("invalid_token", undefined, { "WWW-Authenticate": "Bearer" });
				if (failure.code === "HS404") return error("not_found");
				const seconds = Math.min(60, Math.max(1, failure.retryAfterSeconds ?? 60));
				return error("rate_limited", undefined, { "Retry-After": String(seconds) });
			}
			// Never the token or its hash: only what failed.
			console.error(
				"api/v1: request failed",
				failure instanceof Error ? `${failure.name}: ${failure.message}` : failure
			);
			return error("server_error");
		}
	};
}
