import { describe, expect, test } from "bun:test";

import { computeShares } from "@/lib/ledger";
import {
	answeringSide,
	awaitedSide,
	canAnswer,
	counterpart,
	countsAtOnce,
	isPendingPayment,
	mayUndo,
	paymentSides,
	pendingPaymentBetween,
	recordableForOthers,
} from "@/lib/payment-rules";
import type { EntryRow, MemberRow } from "@/lib/sync/types";
import { serverBill, serverMember } from "../support/memory-tables";

const LEFT = "2026-11-02T00:00:00.000Z";
const AT = "2026-11-03T00:00:00.000Z";

const member = (id: string, overrides: Partial<MemberRow> = {}) =>
	serverMember({ id, groupId: "g1", userId: `u-${id}`, displayName: id, role: "member", ...overrides });

// Sam pays Alex 500, recorded by `by`; the recorder's side has confirmed.
const payment = (by: "sam" | "alex", overrides: Partial<EntryRow> = {}): EntryRow =>
	serverBill({
		id: `p-${by}`,
		groupId: "g1",
		kind: "payment",
		items: null,
		amountCents: 500,
		createdByMemberId: by,
		paymentStatus: "pending",
		payerConfirmedAt: by === "sam" ? AT : null,
		receiverConfirmedAt: by === "alex" ? AT : null,
		shares: computeShares([{ id: "p", amountCents: 500, paidBy: "sam", splitAmong: ["alex"] }]),
		...overrides,
	});

describe("the two sides", () => {
	test("paymentSides: the payer paid, the receiver owes", () => {
		expect(paymentSides(payment("sam"))).toEqual({ from: "sam", to: "alex" });
		expect(paymentSides({ shares: [] })).toEqual({ from: undefined, to: undefined });
	});

	test("counterpart is the other side", () => {
		expect([counterpart(payment("sam"), "sam"), counterpart(payment("sam"), "alex")]).toEqual(["alex", "sam"]);
	});

	test("canAnswer: still in the group, with a login", () => {
		expect(canAnswer(member("sam"))).toBe(true);
		expect(canAnswer(member("jo", { userId: null }))).toBe(false);
		expect(canAnswer(member("kim", { deletedAt: LEFT }))).toBe(false);
		expect(canAnswer(undefined)).toBe(false);
	});
});

describe("answering", () => {
	test("the side that hasn't confirmed answers; the recorder waits", () => {
		expect([answeringSide(payment("sam"), "alex"), answeringSide(payment("sam"), "sam")]).toEqual(["receiver", null]);
		expect([answeringSide(payment("alex"), "sam"), answeringSide(payment("alex"), "alex")]).toEqual(["payer", null]);
		expect(answeringSide(payment("sam"), "jo")).toBeNull();
		expect(answeringSide(payment("sam"), null)).toBeNull();
	});

	test("awaitedSide: the receiver once the payer confirmed, else the payer", () => {
		expect([awaitedSide(payment("sam")), awaitedSide(payment("alex"))]).toEqual(["alex", "sam"]);
	});

	test("only the recorder may undo", () => {
		expect([mayUndo(payment("sam"), "sam"), mayUndo(payment("sam"), "alex"), mayUndo(payment("sam"), null)]).toEqual([
			true,
			false,
			false,
		]);
	});
});

describe("recording", () => {
	const sam = member("sam");
	const jo = member("jo", { userId: null });
	const kim = member("kim", { deletedAt: LEFT });

	test("counts at once unless the payer records it and the receiver can answer", () => {
		expect(countsAtOnce("sam", "sam", member("alex"))).toBe(false);
		expect(countsAtOnce("alex", "sam", member("alex"))).toBe(true); // the receiver says they were paid
		expect(countsAtOnce("sam", "sam", jo)).toBe(true); // name-only
		expect(countsAtOnce("sam", "sam", kim)).toBe(true); // left
		expect(countsAtOnce("alex", "jo", kim)).toBe(true); // for others
	});

	test("someone else may record only between two people who can't answer", () => {
		expect(recordableForOthers(jo, kim)).toBe(true);
		expect(recordableForOthers(jo, sam)).toBe(false);
		expect(recordableForOthers(sam, jo)).toBe(false);
	});

	test("pendingPaymentBetween finds it either way round, pending only", () => {
		const entries = [payment("sam", { id: "done", paymentStatus: "confirmed" }), payment("sam")];
		expect(pendingPaymentBetween(entries, "sam", "alex")?.id).toBe("p-sam");
		expect(pendingPaymentBetween(entries, "alex", "sam")?.id).toBe("p-sam");
		expect(pendingPaymentBetween(entries, "jo", "alex")).toBeUndefined();
		expect(isPendingPayment(entries[0])).toBe(false);
		expect(isPendingPayment({ kind: "expense", paymentStatus: null })).toBe(false);
	});
});
