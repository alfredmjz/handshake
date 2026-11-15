import { describe, expect, test } from "bun:test";

import { computeShares, summarizeGroup, type Item } from "@/lib/ledger";
import { billItems, countPayments, guestsLosingAccess, paymentCards, settleRows } from "@/lib/settle-view";
import type { EntryRow, MemberRow } from "@/lib/sync/types";
import { serverBill, serverMember } from "../support/memory-tables";

const item = (id: string, amountCents: number, paidBy: string, splitAmong: string[]): Item => ({
	id,
	amountCents,
	paidBy,
	splitAmong,
});

const member = (id: string, displayName: string, overrides: Partial<MemberRow> = {}) =>
	serverMember({ id, groupId: "g1", userId: `u-${id}`, displayName, role: "member", ...overrides });

const bill = (id: string, items: Item[]): EntryRow =>
	serverBill({
		id,
		groupId: "g1",
		createdByMemberId: items[0].paidBy,
		items,
		amountCents: items.reduce((t, i) => t + i.amountCents, 0),
		shares: computeShares(items),
	});

const payment = (id: string, from: string, to: string, amountCents: number, overrides: Partial<EntryRow> = {}) =>
	serverBill({
		id,
		groupId: "g1",
		createdByMemberId: from,
		kind: "payment",
		description: "",
		items: null,
		amountCents,
		paymentStatus: "pending",
		payerConfirmedAt: "2026-11-02T00:00:00.000Z",
		shares: computeShares([item("p", amountCents, from, [to])]),
		...overrides,
	});

const ledger = (members: MemberRow[]) =>
	members.map((m) => ({ id: m.id, displayName: m.displayName, hasLogin: m.userId !== null }));

describe("billItems", () => {
	test("returns the stored items", () => {
		const items = [item("i1", 900, "alex", ["alex", "jo"])];
		expect(billItems(bill("e1", items))).toEqual(items);
	});

	test("rebuilds one item from the shares when a bill has none", () => {
		const entry = { ...bill("e1", [item("i1", 900, "alex", ["alex", "jo", "sam"])]), items: null };
		expect(billItems(entry)).toEqual([
			{ id: "e1-item", amountCents: 900, paidBy: "alex", splitAmong: ["alex", "jo", "sam"] },
		]);
	});
});

describe("settleRows", () => {
	const alex = member("alex", "Alex", { role: "owner" });
	const jo = member("jo", "Jo");
	const priya = member("priya", "Priya");
	const sam = member("sam", "sam");
	const members = [alex, jo, priya, sam];

	test("you first, then by name; states from debts and pending payments", () => {
		// Alex paid $90 for Alex, Jo and Sam: Jo and Sam owe Alex $30 each. Sam has a payment waiting.
		const entries = [bill("e1", [item("i1", 9000, "alex", ["alex", "jo", "sam"])])];
		const pending = [payment("p1", "sam", "alex", 3000)];
		const summary = summarizeGroup(entries, ledger(members));
		const rows = settleRows(members, summary, pending, "jo");
		expect(rows.map((r) => [r.member.id, r.state, r.owesCents, r.owedCents])).toEqual([
			["jo", "owes", 3000, 0],
			["alex", "waiting", 0, 6000],
			["priya", "settled", 0, 0],
			["sam", "waiting", 3000, 0],
		]);
	});

	test("someone who left shows only while money is open", () => {
		const left = member("kim", "Kim", { deletedAt: "2026-11-03T00:00:00.000Z" });
		const gone = member("lee", "Lee", { deletedAt: "2026-11-03T00:00:00.000Z" });
		const entries = [bill("e1", [item("i1", 2000, "alex", ["alex", "kim"])])];
		const all = [alex, left, gone];
		const rows = settleRows(all, summarizeGroup(entries, ledger(all)), [], "alex");
		expect(rows.map((r) => [r.member.id, r.state])).toEqual([
			["alex", "owed"],
			["kim", "owes"],
		]);
	});

	test("owing one person and being owed by another still owes", () => {
		const entries = [
			bill("e1", [item("i1", 2000, "jo", ["jo", "alex"])]),
			bill("e2", [item("i2", 6000, "alex", ["alex", "sam"])]),
		];
		const rows = settleRows(members, summarizeGroup(entries, ledger(members)), [], null);
		const alexRow = rows.find((r) => r.member.id === "alex")!;
		expect([alexRow.state, alexRow.owesCents, alexRow.owedCents, alexRow.balanceCents]).toEqual([
			"owes",
			1000,
			3000,
			2000,
		]);
	});
});

describe("paymentCards", () => {
	const alex = member("alex", "Alex", { role: "owner" });
	const jo = member("jo", "Jo");
	const kim = member("kim", "Kim", { userId: null });
	const lee = member("lee", "Lee", { userId: null });
	const members = [alex, jo, kim, lee];
	const debts = [
		{ fromMemberId: "jo", toMemberId: "alex", amountCents: 5000 },
		{ fromMemberId: "kim", toMemberId: "lee", amountCents: 700 },
		{ fromMemberId: "kim", toMemberId: "jo", amountCents: 300 },
	];

	test("your debts, then debts between two name-only people for full members", () => {
		expect(paymentCards(debts, [], members, { memberId: "alex", role: "owner" })).toEqual([
			{ kind: "record", from: "jo", to: "alex", amountCents: 5000, debt: debts[0] },
			{ kind: "record", from: "kim", to: "lee", amountCents: 700, debt: debts[1] },
		]);
	});

	test("guests get only their own", () => {
		expect(paymentCards(debts, [], members, { memberId: "jo", role: "guest" })).toEqual([
			{ kind: "record", from: "jo", to: "alex", amountCents: 5000, debt: debts[0] },
			{ kind: "record", from: "kim", to: "jo", amountCents: 300, debt: debts[2] },
		]);
	});

	test("a pending payment takes its debt's place: the other side answers, the starter waits", () => {
		const pending = [payment("p1", "jo", "alex", 2000)];
		expect(paymentCards(debts, pending, members, { memberId: "alex", role: "owner" })[0]).toEqual({
			kind: "answer",
			entry: pending[0],
			entryId: "p1",
			from: "jo",
			to: "alex",
			amountCents: 2000,
			debt: debts[0],
		});
		expect(paymentCards(debts, pending, members, { memberId: "jo", role: "member" })[0]).toEqual({
			kind: "waiting",
			entry: pending[0],
			entryId: "p1",
			from: "jo",
			to: "alex",
			amountCents: 2000,
			canUndo: true,
			debt: debts[0],
		});
	});

	test("a pending payment with no debt behind it still shows to its two people only", () => {
		const pending = [
			payment("p1", "alex", "jo", 1000, {
				createdByMemberId: "jo",
				payerConfirmedAt: null,
				receiverConfirmedAt: "2026-11-02T00:00:00.000Z",
			}),
		];
		expect(paymentCards([], pending, members, { memberId: "alex", role: "owner" })).toEqual([
			{ kind: "answer", entry: pending[0], entryId: "p1", from: "alex", to: "jo", amountCents: 1000, debt: undefined },
		]);
		expect(paymentCards([], pending, members, { memberId: "kim", role: "member" })).toEqual([]);
	});
});

describe("small helpers", () => {
	test("guestsLosingAccess: active guests with a login, by name", () => {
		const members = [
			member("a", "lee", { role: "guest" }),
			member("b", "Kim", { role: "guest" }),
			member("c", "Mo", { role: "guest", deletedAt: "2026-11-03T00:00:00.000Z" }),
			member("d", "Name only", { role: "guest", userId: null }),
			member("e", "Jo"),
		];
		expect(guestsLosingAccess(members).map((m) => m.displayName)).toEqual(["Kim", "lee"]);
	});

	test("countPayments", () => {
		expect([countPayments(1), countPayments(2), countPayments(12)]).toEqual([
			"One payment",
			"Two payments",
			"12 payments",
		]);
	});
});
