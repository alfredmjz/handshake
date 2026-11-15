import { describe, expect, test } from "bun:test";

import { computeShares } from "@/lib/ledger";
import { canAnswer, pendingPaymentBetween, readPayment, recordingRule } from "@/lib/payment-rules";
import type { EntryRow, MemberRow } from "@/lib/sync/types";
import { serverBill, serverMember } from "../support/memory-tables";

const LEFT = "2026-11-02T00:00:00.000Z";
const AT = "2026-11-03T00:00:00.000Z";
const UPDATED = "2026-11-01T12:00:00.000Z";

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

describe("readPayment: the two sides", () => {
	test("the payer paid, the receiver owes; null for a bill or a payment missing a side", () => {
		expect(readPayment(payment("sam"))).toMatchObject({ from: "sam", to: "alex", status: "pending" });
		expect(readPayment(payment("sam", { shares: [] }))).toBeNull();
		expect(readPayment(payment("sam", { kind: "expense", paymentStatus: null }))).toBeNull();
	});

	test("side and other are from my view; neither when I'm not a side or nobody", () => {
		expect(readPayment(payment("sam"), "sam")).toMatchObject({ side: "payer", other: "alex" });
		expect(readPayment(payment("sam"), "alex")).toMatchObject({ side: "receiver", other: "sam" });
		expect(readPayment(payment("sam"), "jo")).toMatchObject({ side: null, other: null });
		expect(readPayment(payment("sam"))).toMatchObject({ side: null, other: null, answeringAs: null, mayUndo: false });
	});

	test("signed: which sides have confirmed", () => {
		expect(readPayment(payment("sam"))?.signed).toEqual({ payer: true, receiver: false });
		expect(readPayment(payment("alex"))?.signed).toEqual({ payer: false, receiver: true });
	});

	test("canAnswer: still in the group, with a login", () => {
		expect(canAnswer(member("sam"))).toBe(true);
		expect(canAnswer(member("jo", { userId: null }))).toBe(false);
		expect(canAnswer(member("kim", { deletedAt: LEFT }))).toBe(false);
		expect(canAnswer(undefined)).toBe(false);
	});
});

describe("readPayment: answering", () => {
	test("the side that hasn't confirmed answers; the recorder waits", () => {
		const as = (by: "sam" | "alex", me: string | null) => readPayment(payment(by), me)?.answeringAs;
		expect([as("sam", "alex"), as("sam", "sam")]).toEqual(["receiver", null]);
		expect([as("alex", "sam"), as("alex", "alex")]).toEqual(["payer", null]);
		expect([as("sam", "jo"), as("sam", null)]).toEqual([null, null]);
	});

	test("answerer: while pending, the receiver once the payer confirmed, else the payer", () => {
		expect([readPayment(payment("sam"))?.answerer, readPayment(payment("alex"))?.answerer]).toEqual(["alex", "sam"]);
	});

	test("answerer: once declined, the side that declined; otherwise none", () => {
		const declined = (by: "sam" | "alex") => readPayment(payment(by, { paymentStatus: "declined" }))?.answerer;
		expect([declined("sam"), declined("alex")]).toEqual(["alex", "sam"]);
		expect(readPayment(payment("sam", { paymentStatus: "confirmed" }))?.answerer).toBeNull();
		expect(readPayment(payment("sam", { paymentStatus: "undone" }))?.answerer).toBeNull();
	});

	test("only the recorder may undo", () => {
		const undo = (me: string | null) => readPayment(payment("sam"), me)?.mayUndo;
		expect([undo("sam"), undo("alex"), undo(null)]).toEqual([true, false, false]);
	});

	test("nothing to answer or undo once it isn't pending", () => {
		for (const paymentStatus of ["confirmed", "declined", "undone"] as const) {
			const answered = { ...payment("sam"), paymentStatus, payerConfirmedAt: null };
			expect(readPayment(answered, "sam")).toMatchObject({ answeringAs: null, mayUndo: false });
		}
	});

	test("countedAt: when it was confirmed (its update time when that's missing), only once it counts", () => {
		expect(readPayment(payment("sam"))?.countedAt).toBeNull();
		expect(readPayment(payment("sam", { paymentStatus: "confirmed", confirmedAt: AT }))?.countedAt).toBe(AT);
		expect(readPayment(payment("sam", { paymentStatus: "confirmed" }))?.countedAt).toBe(UPDATED);
		expect(readPayment(payment("sam", { paymentStatus: "declined", confirmedAt: AT }))?.countedAt).toBeNull();
	});
});

describe("recordingRule", () => {
	const sam = member("sam");
	const alex = member("alex");
	const jo = member("jo", { userId: null });
	const kim = member("kim", { deletedAt: LEFT });

	test("counts at once unless the payer records it and the receiver can answer", () => {
		expect(recordingRule("sam", sam, alex).countsAtOnce).toBe(false);
		expect(recordingRule("alex", sam, alex).countsAtOnce).toBe(true); // the receiver says they were paid
		expect(recordingRule("sam", sam, jo).countsAtOnce).toBe(true); // name-only
		expect(recordingRule("sam", sam, kim).countsAtOnce).toBe(true); // left
		expect(recordingRule("alex", jo, kim).countsAtOnce).toBe(true); // for others
	});

	test("a side may record; someone else only between two people who can't answer", () => {
		expect(recordingRule("sam", sam, jo).mayRecord).toBe(true);
		expect(recordingRule("jo", sam, jo).mayRecord).toBe(true);
		expect(recordingRule("alex", jo, kim).mayRecord).toBe(true);
		expect(recordingRule("alex", jo, sam).mayRecord).toBe(false);
		expect(recordingRule("alex", sam, jo).mayRecord).toBe(false);
	});

	test("nobody records as nobody", () => {
		expect(recordingRule(undefined, sam, alex)).toEqual({ mayRecord: false, countsAtOnce: true });
	});

	test("pendingPaymentBetween finds it either way round, pending only", () => {
		const entries = [payment("sam", { id: "done", paymentStatus: "confirmed" }), payment("sam")];
		expect(pendingPaymentBetween(entries, "sam", "alex")?.id).toBe("p-sam");
		expect(pendingPaymentBetween(entries, "alex", "sam")?.id).toBe("p-sam");
		expect(pendingPaymentBetween(entries, "jo", "alex")).toBeUndefined();
		expect(pendingPaymentBetween([payment("sam", { kind: "expense" })], "sam", "alex")).toBeUndefined();
	});
});
